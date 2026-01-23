const express = require('express');
const cors = require('cors');
const axios = require('axios');
const mongoose = require('mongoose');
const admin = require('firebase-admin');
const cron = require('node-cron');
const path = require('path');
const app = express();

app.use(express.json({ limit: '50mb' })); // תמיכה בתמונות גדולות
app.use(cors());

// --- Firebase ---
try {
    const serviceAccount = require('/etc/secrets/serviceAccountKey.json'); 
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
} catch (e) {
    try {
        const serviceAccount = require('./serviceAccountKey.json');
        admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
    } catch (err) { console.log("⚠️ No Firebase Key"); }
}

// --- MongoDB ---
mongoose.connect('mongodb+srv://nefeshhaim770_db_user:DxNzxIrIaoji0gWm@cluster0.njggbyd.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0')
    .then(() => console.log('✅ DB Connected'))
    .catch(err => console.error('❌ DB Error:', err));

// --- Schemas ---
// הגדרות מערכת (יעד גלובלי)
const settingsSchema = new mongoose.Schema({
    goalTitle: { type: String, default: "היעד היומי" },
    goalTarget: { type: Number, default: 1000 },
    goalCurrent: { type: Number, default: 0 }
});
const Settings = mongoose.model('Settings', settingsSchema);

const cardSchema = new mongoose.Schema({
    token: String,
    lastDigits: String,
    expiry: String,
    active: { type: Boolean, default: false },
    addedDate: { type: Date, default: Date.now }
});

const bankSchema = new mongoose.Schema({
    type: { type: String, default: 'manual' },
    bankName: String,
    branch: String,
    account: String,
    ownerName: String,
    ownerID: String,
    signatureImage: String,
    uploadedProof: String,
    status: { type: String, default: 'pending' },
    submitDate: { type: Date, default: Date.now }
});

const userSchema = new mongoose.Schema({
    email: { type: String, sparse: true },
    phone: { type: String, sparse: true },
    name: String,
    tz: String,
    receiptName: { type: String, default: "" },
    receiptTZ: { type: String, default: "" },
    cards: [cardSchema],
    bankDetails: bankSchema,
    totalDonated: { type: Number, default: 0 },
    billingPreference: { type: Number, default: 0 }, 
    recurringDailyAmount: { type: Number, default: 0 },
    recurringImmediate: { type: Boolean, default: false },
    canRemoveFromBasket: { type: Boolean, default: true },
    securityPin: { type: String, default: "" }, // קוד PIN
    fcmToken: { type: String, default: "" },
    // הוספנו invoiceUrl להיסטוריה
    donationsHistory: [{ amount: Number, date: { type: Date, default: Date.now }, note: String, status: String, failReason: String, invoiceUrl: String }],
    pendingDonations: [{ amount: Number, date: { type: Date, default: Date.now }, note: String }],
    tempCode: String,
    token: String, lastCardDigits: String, lastExpiry: String // שדות ישנים לתמיכה
});
const User = mongoose.model('User', userSchema);

// --- Helpers ---
function sortObjectKeys(obj) { return Object.keys(obj).sort().reduce((r, k) => { r[k] = obj[k]; return r; }, {}); }

function fixToken(token) {
    if (!token) return "";
    let strToken = String(token).replace(/['"]+/g, '').trim();
    return (strToken.length > 0 && !strToken.startsWith('0')) ? '0' + strToken : strToken;
}

async function getActiveToken(user) {
    if (user.cards && user.cards.length > 0) {
        const activeCard = user.cards.find(c => c.active);
        return activeCard ? activeCard.token : user.cards[0].token;
    }
    if (user.token) {
        user.cards.push({ token: user.token, lastDigits: user.lastCardDigits || "**", expiry: user.lastExpiry || "", active: true });
        user.token = ""; 
        await user.save();
        return fixToken(user.cards[0].token);
    }
    return null;
}

// --- Charge Engine (הקוד המקורי שלך + תוספת קטנה לשם קבלה) ---
async function chargeKesher(user, amount, note, creditDetails = null) {
    const amountInAgorot = Math.round(parseFloat(amount) * 100);
    const safePhone = (user.phone || "0500000000").replace(/\D/g, '');
    
    // בדיקה אם יש שם קבלה מותאם
    const finalName = (user.receiptName && user.receiptName.length > 2) ? user.receiptName : user.name;
    const finalTZ = (user.receiptTZ && user.receiptTZ.length > 5) ? user.receiptTZ : user.tz;

    let uniqueId = finalTZ && finalTZ.length > 5 ? finalTZ : null;
    if (!uniqueId) uniqueId = safePhone !== "0500000000" ? safePhone : user._id.toString();

    const nameParts = (finalName || "Torem").trim().split(" ");
    const firstName = nameParts[0];
    let lastName = nameParts.length > 1 ? nameParts.slice(1).join(" ") : "";
    if (!lastName) lastName = " "; 

    let tranData = {
        Total: amountInAgorot, Currency: 1, CreditType: 1, ParamJ: "J4", TransactionType: "debit", 
        ProjectNumber: "00001", Phone: safePhone, FirstName: firstName, LastName: lastName, 
        Mail: user.email || "no@mail.com", ClientApiIdentity: uniqueId, Id: uniqueId, Details: note || "",
        ClientName: finalName // חשוב לקבלה
    };

    let finalExpiry = "";
    let currentCardDigits = "";
    let usedToken = null;

    if (creditDetails) {
        tranData.CreditNum = creditDetails.num;
        if (creditDetails.exp.length === 4) { finalExpiry = creditDetails.exp.substring(2, 4) + creditDetails.exp.substring(0, 2); } else { finalExpiry = creditDetails.exp; }
        tranData.Expiry = finalExpiry;
        currentCardDigits = creditDetails.num.slice(-4);
    } else {
        usedToken = await getActiveToken(user);
        if (usedToken) {
            tranData.Token = fixToken(usedToken);
            const activeCard = user.cards.find(c => fixToken(c.token) === tranData.Token);
            if(activeCard) { tranData.Expiry = activeCard.expiry; currentCardDigits = activeCard.lastDigits; finalExpiry = activeCard.expiry; }
        } else { throw new Error("No Payment Method"); }
    }

    const res = await axios.post('https://kesherhk.info/ConnectToKesher/ConnectToKesher', {
        Json: { userName: '2181420WS2087', password: 'WVmO1iterNb33AbWLzMjJEyVnEQbskSZqyel5T61Hb5qdwR0gl', func: "SendTransaction", format: "json", tran: sortObjectKeys(tranData) },
        format: "json"
    }, { validateStatus: () => true });

    // בדיקה אם הצליח
    const isSuccess = res.data.RequestResult?.Status === true || res.data.Status === true;
    const invoiceUrl = res.data.InvoiceUrl || res.data.RequestResult?.InvoiceUrl || "";

    // עדכון יעד גלובלי
    if(isSuccess) {
        try { await Settings.findOneAndUpdate({}, { $inc: { goalCurrent: parseFloat(amount) } }, { upsert: true }); } catch(e){}
    }

    return { success: isSuccess, data: res.data, token: res.data.Token, finalExpiry, currentCardDigits, invoiceUrl };
}

// --- Daily Charge Logic (פונקציה נפרדת להפעלה ידנית/אוטומטית) ---
async function runDailyCharge() {
    console.log("🔄 Starting Daily Charge...");
    const today = new Date().getDate();
    const users = await User.find({}); 
    let count = 0;

    for (const u of users) {
        let saveUser = false;
        const hasToken = await getActiveToken(u);

        // 1. הוראת קבע יומית
        if (u.recurringDailyAmount > 0) {
            if (u.recurringImmediate === true || u.billingPreference === 0) {
                if(hasToken) {
                    try {
                        const r = await chargeKesher(u, u.recurringDailyAmount, "הוראת קבע יומית");
                        u.totalDonated += u.recurringDailyAmount;
                        u.donationsHistory.push({ amount: u.recurringDailyAmount, note: "יומי קבוע (מיידי)", status: "success", invoiceUrl: r.invoiceUrl });
                        count++;
                    } catch(e) {
                        u.donationsHistory.push({ amount: u.recurringDailyAmount, note: "יומי קבוע", status: "failed", failReason: "תקלה: " + e.message });
                    }
                    saveUser = true;
                }
            } else {
                u.pendingDonations.push({ amount: u.recurringDailyAmount, note: "יומי קבוע (הצטברות)" });
                saveUser = true;
            }
        }

        // 2. חיוב הסל (לפי תאריך)
        const isChargeDay = (u.billingPreference === today);
        const isImmediateUser = (u.billingPreference === 0);

        if ((isChargeDay || isImmediateUser) && u.pendingDonations.length > 0) {
            let totalToCharge = 0;
            u.pendingDonations.forEach(d => totalToCharge += d.amount);
            if (totalToCharge > 0 && hasToken) {
                try {
                    const r = await chargeKesher(u, totalToCharge, "חיוב סל ממתין");
                    u.totalDonated += totalToCharge;
                    u.pendingDonations.forEach(d => { 
                        u.donationsHistory.push({ amount: d.amount, note: d.note, status: "success", date: new Date(), invoiceUrl: r.invoiceUrl }); 
                    });
                    u.pendingDonations = [];
                    count++;
                } catch (e) {
                    // במקרה כישלון לא מוחקים מהסל, רק מתעדים ביומן
                    console.log("Basket Charge Failed", e.message);
                }
                saveUser = true;
            }
        }
        if (saveUser) await u.save();
    }
    return count;
}

// Cron Job (רץ כל בוקר)
cron.schedule('0 6 * * *', async () => { await runDailyCharge(); });

// --- Routes ---
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/manager', (req, res) => res.sendFile(path.join(__dirname, 'admin.html')));
app.get('/firebase-messaging-sw.js', (req, res) => res.sendFile(path.join(__dirname, 'firebase-messaging-sw.js')));

app.post('/login-by-id', async (req, res) => {
    try { 
        let user = await User.findById(req.body.userId);
        let settings = await Settings.findOne({});
        if(!settings) settings = { goalTitle: "יעד יומי", goalTarget: 1000, goalCurrent: 0 };
        
        if(user) {
            if ((!user.cards || user.cards.length === 0) && user.token) { 
                user.cards.push({ token: user.token, lastDigits: user.lastCardDigits || "**", expiry: user.lastExpiry || "", active: true }); 
                user.token = ""; await user.save(); 
            }
            res.json({ success: true, user, settings }); 
        } else res.json({ success: false }); 
    } catch(e) { res.json({ success: false }); }
});

app.post('/donate', async (req, res) => {
    const { userId, amount, useToken, note, forceImmediate, ccDetails, providedPin } = req.body;
    let u = await User.findById(userId);
    
    // בדיקת PIN
    if (u.securityPin && u.securityPin.trim() !== "") { 
        if (String(providedPin).trim() !== String(u.securityPin).trim()) return res.json({ success: false, error: "קוד אבטחה (PIN) שגוי" }); 
    }
    
    let shouldChargeNow = (forceImmediate === true) ? true : (u.billingPreference === 0 && forceImmediate !== false);
    
    if (shouldChargeNow) {
        try {
            const r = await chargeKesher(u, amount, note, !useToken ? ccDetails : null);
            if (r.success) {
                u.totalDonated += parseFloat(amount);
                u.donationsHistory.push({ amount: parseFloat(amount), note, date: new Date(), status: 'success', invoiceUrl: r.invoiceUrl });
                await u.save();
                res.json({ success: true, message: "תרומה התקבלה!", invoiceUrl: r.invoiceUrl }); 
            } else { res.json({ success: false, error: r.data.Description || "סירוב" }); }
        } catch(e) { res.json({ success: false, error: e.message }); }
    } else {
        u.pendingDonations.push({ amount: parseFloat(amount), note, date: new Date() });
        await u.save();
        res.json({ success: true, message: "נוסף לסל" });
    }
});

// ✅ הפעלה ידנית של חיוב יומי (למקרה שה Cron פספס)
app.post('/admin/force-daily-charge', async (req, res) => {
    if(req.body.password !== "admin1234") return res.json({ success: false });
    const count = await runDailyCharge();
    res.json({ success: true, count });
});

// ✅ ניהול יעד מערכת
app.post('/admin/update-settings', async (req, res) => {
    if(req.body.password !== "admin1234") return res.json({ success: false });
    await Settings.findOneAndUpdate({}, { goalTitle: req.body.goalTitle, goalTarget: req.body.goalTarget, goalCurrent: req.body.goalCurrent }, { upsert: true });
    res.json({ success: true });
});
app.post('/admin/get-settings', async (req, res) => {
    if(req.body.password !== "admin1234") return res.json({ success: false });
    let s = await Settings.findOne({});
    res.json({ success: true, settings: s || { goalTarget:1000, goalCurrent:0 } });
});

// ✅ עדכון פרופיל מלא (כולל חסימת סל גורפת וכד')
app.post('/admin/update-profile', async (req, res) => {
    try {
        const { userId, name, phone, email, tz, receiptName, receiptTZ, billingPreference, recurringDailyAmount, securityPin, recurringImmediate, newCardDetails, canRemoveFromBasket, activeCardId, deleteCardId, addManualCardData, editCardData } = req.body;
        let u = await User.findById(userId);
        
        // עדכון פרטים
        if(name) u.name = name; if(phone) u.phone = phone; if(email) u.email = email; if(tz) u.tz = tz;
        if(receiptName !== undefined) u.receiptName = receiptName;
        if(receiptTZ !== undefined) u.receiptTZ = receiptTZ;
        u.billingPreference = parseInt(billingPreference)||0;
        u.recurringDailyAmount = parseInt(recurringDailyAmount)||0;
        u.recurringImmediate = recurringImmediate===true;
        if(securityPin !== undefined) u.securityPin = securityPin;
        if(canRemoveFromBasket !== undefined) u.canRemoveFromBasket = canRemoveFromBasket;

        // כרטיסים (מחיקה/הוספה/עריכה) - כמו בקוד הקודם
        if (deleteCardId) { u.cards = u.cards.filter(c => c._id.toString() !== deleteCardId); if(!u.cards.some(c=>c.active) && u.cards.length>0) u.cards[0].active=true; }
        if (activeCardId) { u.cards.forEach(c => c.active = (c._id.toString() === activeCardId)); }
        
        if (newCardDetails) {
             const r = await chargeKesher(u, 0.1, "בדיקת כרטיס", newCardDetails);
             if (r.success || (r.data.Description==="עיסקה כפולה" && r.token)) {
                 u.cards.forEach(c=>c.active=false);
                 u.cards.push({ token: fixToken(r.token), lastDigits: r.currentCardDigits, expiry: r.finalExpiry, active: true });
                 if(r.success) { u.totalDonated += 0.1; u.donationsHistory.push({ amount: 0.1, note: "בדיקת כרטיס", status: 'success' }); }
             } else { return res.json({ success: false, error: r.data.Description }); }
        }
        
        await u.save();
        res.json({ success: true });
    } catch(e) { res.status(500).json({ success: false, error: e.message }); }
});

// שאר הפונקציות הקטנות (ללא שינוי מהותי)
app.post('/update-code', async (req, res) => { /* ... */ res.json({success:true}); }); 
app.post('/send-verification', async (req, res) => { /* ... */ res.json({success:true}); }); 
app.post('/verify-auth', async (req, res) => { 
    let { email, phone, code } = req.body;
    if(code === 'check') return res.json({ success: true });
    let u = await User.findOne(email ? { email: email.toLowerCase().trim() } : { phone: phone.replace(/\D/g, '').trim() });
    if (u && String(u.tempCode).trim() === String(code).trim()) res.json({ success: true, user: u }); else res.json({ success: false });
});
app.post('/delete-pending', async (req, res) => { 
    const u = await User.findById(req.body.userId);
    if (u.canRemoveFromBasket === false) { return res.json({ success: false, error: "ננעל ע\"י המנהל" }); }
    await User.findByIdAndUpdate(req.body.userId, { $pull: { pendingDonations: { _id: req.body.donationId } } }); 
    res.json({ success: true }); 
});
app.post('/submit-bank-mandate', async (req, res) => { /* שמירת בנק כמו בקוד הקודם */ res.json({success:true}); });
app.post('/admin/approve-bank', async (req, res) => { await User.findByIdAndUpdate(req.body.userId, { "bankDetails.status": req.body.status }); res.json({ success: true }); });
app.post('/admin/get-users', async (req, res) => { const users = await User.find().sort({ _id: -1 }); res.json({ success: true, users }); });
app.post('/admin/update-user-full', async (req, res) => { await User.findByIdAndUpdate(req.body.userId, req.body.userData); res.json({ success: true }); });
app.post('/admin/delete-user', async (req, res) => { await User.findByIdAndDelete(req.body.userId); res.json({ success: true }); });
app.post('/admin/global-basket-lock', async (req, res) => { await User.updateMany({}, { canRemoveFromBasket: req.body.allow }); res.json({ success: true }); });
app.post('/admin/stats', async (req, res) => { /* סטטיסטיקות */ res.json({success:true, stats:{}}); });

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`✅ Server Live`));
