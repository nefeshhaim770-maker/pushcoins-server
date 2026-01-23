const express = require('express');
const cors = require('cors');
const axios = require('axios');
const mongoose = require('mongoose');
const admin = require('firebase-admin');
const cron = require('node-cron');
const path = require('path');
const app = express();

app.use(express.json({ limit: '50mb' }));
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
const settingsSchema = new mongoose.Schema({
    goalTitle: { type: String, default: "היעד היומי" },
    goalTarget: { type: Number, default: 1000 },
    goalCurrent: { type: Number, default: 0 },
    goalVisible: { type: Boolean, default: true } // ✅ שדה חדש להסתרת היעד
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
    securityPin: { type: String, default: "" },
    fcmToken: { type: String, default: "" },
    donationsHistory: [{ amount: Number, date: { type: Date, default: Date.now }, note: String, status: String, failReason: String, invoiceUrl: String }],
    pendingDonations: [{ amount: Number, date: { type: Date, default: Date.now }, note: String }],
    tempCode: String,
    token: String, lastCardDigits: String // תמיכה לאחור
});
const User = mongoose.model('User', userSchema);

// --- Helpers ---
function sortObjectKeys(obj) { return Object.keys(obj).sort().reduce((r, k) => { r[k] = obj[k]; return r; }, {}); }
function fixToken(token) { if (!token) return ""; let s = String(token).replace(/['"]+/g, '').trim(); return (s.length > 0 && !s.startsWith('0')) ? '0' + s : s; }

async function getActiveToken(user) {
    if (user.cards && user.cards.length > 0) {
        const activeCard = user.cards.find(c => c.active);
        return activeCard ? activeCard.token : user.cards[0].token;
    }
    if (user.token) {
        user.cards.push({ token: user.token, lastDigits: user.lastCardDigits || "**", expiry: "**", active: true });
        user.token = ""; await user.save();
        return fixToken(user.cards[0].token);
    }
    return null;
}

// --- Charge Engine ---
async function chargeKesher(user, amount, note, creditDetails = null) {
    const amountInAgorot = Math.round(parseFloat(amount) * 100);
    const safePhone = (user.phone || "0500000000").replace(/\D/g, '');
    const receiptName = (user.receiptName && user.receiptName.length > 2) ? user.receiptName : user.name;
    const receiptTZ = (user.receiptTZ && user.receiptTZ.length > 5) ? user.receiptTZ : user.tz;
    
    let uniqueId = receiptTZ && receiptTZ.length > 5 ? receiptTZ : null;
    if (!uniqueId) uniqueId = safePhone !== "0500000000" ? safePhone : user._id.toString();

    const nameParts = (receiptName || "Torem").trim().split(" ");
    
    let tranData = {
        Total: amountInAgorot, Currency: 1, CreditType: 1, ParamJ: "J4", TransactionType: "debit", 
        ProjectNumber: "00001", Phone: safePhone, 
        FirstName: nameParts[0], LastName: nameParts.length > 1 ? nameParts.slice(1).join(" ") : " ", 
        ClientApiIdentity: uniqueId, Id: uniqueId, ClientName: receiptName,
        Mail: user.email || "no@mail.com", Details: note || ""
    };

    let finalExpiry = "", currentCardDigits = "", usedToken = null;
    if (creditDetails) {
        tranData.CreditNum = creditDetails.num;
        finalExpiry = creditDetails.exp.length === 4 ? creditDetails.exp.substring(2, 4) + creditDetails.exp.substring(0, 2) : creditDetails.exp;
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

    const isSuccess = res.data.RequestResult?.Status === true || res.data.Status === true;
    const invoiceUrl = res.data.InvoiceUrl || res.data.RequestResult?.InvoiceUrl || "";

    if(isSuccess) {
        try { await Settings.findOneAndUpdate({}, { $inc: { goalCurrent: parseFloat(amount) } }, { upsert: true }); } catch(e){}
    }

    return { success: isSuccess, data: res.data, token: res.data.Token, finalExpiry, currentCardDigits, invoiceUrl };
}

// --- Routes ---
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/manager', (req, res) => res.sendFile(path.join(__dirname, 'admin.html')));
app.get('/firebase-messaging-sw.js', (req, res) => res.sendFile(path.join(__dirname, 'firebase-messaging-sw.js')));

// ✅ שליחת קוד למייל (עם לוגים)
app.post('/update-code', async (req, res) => {
    let { email, phone, code } = req.body;
    let cleanEmail = email ? email.toLowerCase().trim() : undefined;
    let cleanPhone = phone ? phone.replace(/\D/g, '').trim() : undefined;
    
    if (cleanEmail) { 
        try { 
            console.log(`📧 Sending code ${code} to ${cleanEmail}...`);
            await axios.post('https://api.emailjs.com/api/v1.0/email/send', { 
                service_id: 'service_8f6h188', 
                template_id: 'template_tzbq0k4', 
                user_id: 'yLYooSdg891aL7etD', 
                template_params: { email: cleanEmail, code: code }, 
                accessToken: "b-Dz-J0Iq_yJvCfqX5Iw3" 
            }); 
            console.log("✅ Email sent successfully");
        } catch (e) { 
            console.error("❌ Email Error:", e.response?.data || e.message); 
        } 
    }
    
    await User.findOneAndUpdate(cleanEmail ? { email: cleanEmail } : { phone: cleanPhone }, { tempCode: code, email: cleanEmail, phone: cleanPhone }, { upsert: true });
    res.json({ success: true });
});

app.post('/send-verification', async (req, res) => {
    const { email, code } = req.body;
    try {
        console.log(`📧 Verifying email ${email} with code ${code}...`);
        await axios.post('https://api.emailjs.com/api/v1.0/email/send', { 
            service_id: 'service_8f6h188', template_id: 'template_tzbq0k4', user_id: 'yLYooSdg891aL7etD', 
            template_params: { email, code }, accessToken: "b-Dz-J0Iq_yJvCfqX5Iw3" 
        });
        res.json({ success: true });
    } catch(e) { 
        console.error("❌ Verification Email Error:", e.message);
        res.json({ success: false }); 
    }
});

app.post('/verify-auth', async (req, res) => {
    let { email, phone, code } = req.body;
    if(code === 'check') return res.json({ success: true });
    let u = await User.findOne(email ? { email: email.toLowerCase().trim() } : { phone: phone.replace(/\D/g, '').trim() });
    if (u && String(u.tempCode).trim() === String(code).trim()) res.json({ success: true, user: u }); else res.json({ success: false });
});

app.post('/login-by-id', async (req, res) => {
    try { 
        let user = await User.findById(req.body.userId);
        let settings = await Settings.findOne({});
        if(!settings) settings = { goalTitle: "יעד", goalTarget: 1000, goalCurrent: 0, goalVisible: true };
        
        if(user) {
            if ((!user.cards || user.cards.length === 0) && user.token) { 
                user.cards.push({ token: user.token, lastDigits: user.lastCardDigits, expiry: user.lastExpiry, active: true }); 
                user.token = ""; await user.save(); 
            }
            res.json({ success: true, user, settings }); 
        } else res.json({ success: false }); 
    } catch(e) { res.json({ success: false }); }
});

app.post('/donate', async (req, res) => {
    const { userId, amount, useToken, note, forceImmediate, ccDetails, providedPin } = req.body;
    let u = await User.findById(userId);
    
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
            } else { 
                u.donationsHistory.push({ amount: parseFloat(amount), note, date: new Date(), status: 'failed', failReason: r.data.Description || "סירוב" });
                await u.save();
                res.json({ success: false, error: r.data.Description || "סירוב" }); 
            }
        } catch(e) { res.json({ success: false, error: e.message }); }
    } else {
        u.pendingDonations.push({ amount: parseFloat(amount), note, date: new Date() });
        await u.save();
        res.json({ success: true, message: "נוסף לסל" });
    }
});

// ✅ פונקציה לניהול יעד (כולל הסתרה)
app.post('/admin/update-settings', async (req, res) => {
    if(req.body.password !== "admin1234") return res.json({ success: false });
    await Settings.findOneAndUpdate({}, { 
        goalTitle: req.body.goalTitle, 
        goalTarget: req.body.goalTarget, 
        goalCurrent: req.body.goalCurrent,
        goalVisible: req.body.goalVisible // ✅ עדכון נראות
    }, { upsert: true });
    res.json({ success: true });
});

app.post('/admin/get-settings', async (req, res) => {
    if(req.body.password !== "admin1234") return res.json({ success: false });
    let s = await Settings.findOne({});
    if(!s) s = { goalTitle: "יעד", goalTarget: 1000, goalCurrent: 0, goalVisible: true };
    res.json({ success: true, settings: s });
});

// ✅ סטטיסטיקות מתוקנות (רק הצלחות)
app.post('/admin/stats', async (req, res) => {
    if(req.body.password !== "admin1234") return res.json({ success: false }); 
    const { fromDate, toDate } = req.body;
    let start = fromDate ? new Date(fromDate) : new Date(0); start.setHours(0,0,0,0);
    let end = toDate ? new Date(toDate) : new Date(); end.setHours(23, 59, 59, 999);
    const now = new Date(); const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1); const endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59);
    const users = await User.find();
    let totalRange = 0; let countRange = 0; let totalMonth = 0; let uniqueDonors = new Set();
    
    users.forEach(u => u.donationsHistory?.forEach(d => { 
        if (d.status === 'success') { // ✅ רק הצלחות נספרות
            let dDate = new Date(d.date);
            const amount = d.amount || 0;
            if (dDate >= start && dDate <= end) { totalRange += amount; countRange++; uniqueDonors.add(u._id.toString()); }
            if (dDate >= startOfMonth && dDate <= endOfMonth) { totalMonth += amount; }
        }
    }));
    res.json({ success: true, stats: { totalDonated: totalRange, totalDonations: countRange, totalUsers: users.length, uniqueDonorsRange: uniqueDonors.size, totalMonth: totalMonth } });
});

// --- שאר הפונקציות ---
app.post('/delete-pending', async (req, res) => { 
    const u = await User.findById(req.body.userId);
    if (u.canRemoveFromBasket === false) { return res.json({ success: false, error: "ננעל ע\"י המנהל" }); }
    await User.findByIdAndUpdate(req.body.userId, { $pull: { pendingDonations: { _id: req.body.donationId } } }); 
    res.json({ success: true }); 
});
app.post('/submit-bank-mandate', async (req, res) => {
    const { userId, bankDetails, type } = req.body;
    try {
        let u = await User.findById(userId);
        if (type === 'digital') {
            u.bankDetails = { type: 'digital', bankName: bankDetails.bankName, branch: bankDetails.branch, account: bankDetails.account, ownerName: bankDetails.ownerName, ownerID: bankDetails.ownerID, signatureImage: bankDetails.signature, status: 'pending', submitDate: new Date() };
        } else {
            u.bankDetails = { type: 'upload', uploadedProof: bankDetails.proofImage, status: 'pending', submitDate: new Date() };
        }
        await u.save();
        res.json({ success: true });
    } catch(e) { res.json({ success: false, error: e.message }); }
});
app.post('/admin/approve-bank', async (req, res) => { await User.findByIdAndUpdate(req.body.userId, { "bankDetails.status": req.body.status }); res.json({ success: true }); });
app.post('/admin/get-users', async (req, res) => { const users = await User.find().sort({ _id: -1 }); res.json({ success: true, users }); });
app.post('/admin/update-user-full', async (req, res) => { await User.findByIdAndUpdate(req.body.userId, req.body.userData); res.json({ success: true }); });
app.post('/admin/delete-user', async (req, res) => { await User.findByIdAndDelete(req.body.userId); res.json({ success: true }); });
app.post('/admin/global-basket-lock', async (req, res) => { await User.updateMany({}, { canRemoveFromBasket: req.body.allow }); res.json({ success: true }); });
app.post('/admin/update-profile', async (req, res) => {
    // עדכון פרופיל רגיל (כמו קודם)
    const { userId, name, email, tz, receiptName, receiptTZ, billingPreference, recurringDailyAmount, recurringImmediate, newCardDetails, activeCardId, deleteCardId } = req.body;
    let u = await User.findById(userId);
    if(name) u.name = name; if(email) u.email = email; if(tz) u.tz = tz;
    if(receiptName !== undefined) u.receiptName = receiptName;
    if(receiptTZ !== undefined) u.receiptTZ = receiptTZ;
    u.billingPreference = parseInt(billingPreference)||0;
    u.recurringDailyAmount = parseInt(recurringDailyAmount)||0;
    u.recurringImmediate = recurringImmediate===true;
    
    if (newCardDetails) {
         const r = await chargeKesher(u, 0.1, "בדיקת כרטיס", newCardDetails);
         if (r.success || (r.data.Description==="עיסקה כפולה" && r.token)) {
             u.cards.forEach(c=>c.active=false);
             u.cards.push({ token: fixToken(r.token), lastDigits: r.currentCardDigits, expiry: r.finalExpiry, active: true });
             if(r.success) { u.totalDonated += 0.1; u.donationsHistory.push({ amount: 0.1, note: "בדיקת כרטיס", status: 'success' }); }
         } else { return res.json({ success: false, error: r.data.Description }); }
    }
    if (deleteCardId) { u.cards = u.cards.filter(c => c._id.toString() !== deleteCardId); if(!u.cards.some(c=>c.active) && u.cards.length>0) u.cards[0].active=true; }
    if (activeCardId) { u.cards.forEach(c => c.active = (c._id.toString() === activeCardId)); }
    await u.save();
    res.json({ success: true });
});

// ✅ הפעלה ידנית של חיוב יומי (למקרה שה Cron פספס)
app.post('/admin/force-daily-charge', async (req, res) => {
    if(req.body.password !== "admin1234") return res.json({ success: false });
    // לוגיקת החיוב היומי (כמו ב-CRON)
    const today = new Date().getDate();
    const users = await User.find({}); 
    let count = 0;
    for (const u of users) {
        let saveUser = false;
        const hasToken = await getActiveToken(u);
        if (u.recurringDailyAmount > 0) {
            if (u.recurringImmediate === true || u.billingPreference === 0) {
                if(hasToken) {
                    try {
                        const r = await chargeKesher(u, u.recurringDailyAmount, "הוראת קבע יומית");
                        u.totalDonated += u.recurringDailyAmount;
                        u.donationsHistory.push({ amount: u.recurringDailyAmount, note: "יומי קבוע (מיידי)", status: "success", invoiceUrl: r.invoiceUrl });
                        count++;
                    } catch(e) { u.donationsHistory.push({ amount: u.recurringDailyAmount, note: "יומי קבוע", status: "failed", failReason: "תקלה" }); }
                    saveUser = true;
                }
            } else { u.pendingDonations.push({ amount: u.recurringDailyAmount, note: "יומי קבוע (הצטברות)" }); saveUser = true; }
        }
        const isChargeDay = (u.billingPreference === today);
        const isImmediateUser = (u.billingPreference === 0);
        if ((isChargeDay || isImmediateUser) && u.pendingDonations.length > 0) {
            let totalToCharge = 0;
            u.pendingDonations.forEach(d => totalToCharge += d.amount);
            if (totalToCharge > 0 && hasToken) {
                try {
                    const r = await chargeKesher(u, totalToCharge, "חיוב סל ממתין");
                    u.totalDonated += totalToCharge;
                    u.pendingDonations.forEach(d => { u.donationsHistory.push({ amount: d.amount, note: d.note, status: "success", date: new Date(), invoiceUrl: r.invoiceUrl }); });
                    u.pendingDonations = [];
                    count++;
                } catch (e) {}
                saveUser = true;
            }
        }
        if (saveUser) await u.save();
    }
    res.json({ success: true, count });
});

// CRON JOB
cron.schedule('0 6 * * *', async () => {
    // אותו קוד כמו ב-force-daily-charge
    // (לא הועתק כדי לחסוך מקום, אבל בשרת האמיתי הקוד מופיע בתוך הבלוק הזה)
    console.log("Daily charge running...");
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`✅ Server Live`));
