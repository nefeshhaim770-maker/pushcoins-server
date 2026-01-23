const express = require('express');
const cors = require('cors');
const axios = require('axios');
const mongoose = require('mongoose');
const admin = require('firebase-admin');
const cron = require('node-cron');
const path = require('path');
const app = express();

// הגדרות נפח להעלאת תמונות גדולות (חובה לבנק)
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
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

// הגדרות מערכת גלובליות (יעד)
const settingsSchema = new mongoose.Schema({
    goalTitle: { type: String, default: "היעד היומי" },
    goalTarget: { type: Number, default: 1000 },
    goalCurrent: { type: Number, default: 0 },
    goalVisible: { type: Boolean, default: true } // שליטה האם להציג ללקוח
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
    type: { type: String, default: 'manual' }, // 'digital' / 'upload'
    bankName: String,
    branch: String,
    account: String,
    ownerName: String,
    ownerID: String,
    signatureImage: String, // Base64
    uploadedProof: String, // Base64
    status: { type: String, default: 'none' }, // none, pending, active, rejected
    submitDate: { type: Date }
});

const userSchema = new mongoose.Schema({
    email: { type: String, sparse: true },
    phone: { type: String, sparse: true },
    name: String,
    tz: String,
    receiptName: { type: String, default: "" },
    receiptTZ: { type: String, default: "" },
    
    cards: [cardSchema],
    bankDetails: { type: bankSchema, default: {} },

    totalDonated: { type: Number, default: 0 },
    billingPreference: { type: Number, default: 0 }, 
    recurringDailyAmount: { type: Number, default: 0 },
    recurringImmediate: { type: Boolean, default: false },
    canRemoveFromBasket: { type: Boolean, default: true },
    securityPin: { type: String, default: "" },
    fcmToken: { type: String, default: "" },
    
    donationsHistory: [{ 
        amount: Number, 
        date: { type: Date, default: Date.now }, 
        note: String, 
        status: String, 
        failReason: String, 
        invoiceUrl: String 
    }],
    
    pendingDonations: [{ amount: Number, date: { type: Date, default: Date.now }, note: String }],
    tempCode: String,
    token: String // תמיכה לאחור
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
        user.cards.push({ token: user.token, lastDigits: "**", expiry: "**", active: true });
        user.token = ""; await user.save();
        return fixToken(user.cards[0].token);
    }
    return null;
}

// --- Charge Engine (Kesher API) ---
async function chargeKesher(user, amount, note, creditDetails = null) {
    const amountInAgorot = Math.round(parseFloat(amount) * 100);
    const safePhone = (user.phone || "0500000000").replace(/\D/g, '');
    
    // פרטי קבלה מותאמים
    const finalName = (user.receiptName && user.receiptName.length > 2) ? user.receiptName : user.name;
    const finalTZ = (user.receiptTZ && user.receiptTZ.length > 5) ? user.receiptTZ : user.tz;
    
    let uniqueId = finalTZ && finalTZ.length > 5 ? finalTZ : null;
    if (!uniqueId) uniqueId = safePhone !== "0500000000" ? safePhone : user._id.toString();

    // פירוק שם למשפחה ופרטי (דרישת API)
    const nameParts = (finalName || "Torem").trim().split(" ");
    const firstName = nameParts[0];
    let lastName = nameParts.length > 1 ? nameParts.slice(1).join(" ") : " ";

    let tranData = {
        Total: amountInAgorot, 
        Currency: 1, 
        CreditType: 1, 
        ParamJ: "J4", 
        TransactionType: "debit", 
        ProjectNumber: "00001", // וודא שזה המספר שלך בקשר
        Phone: safePhone, 
        FirstName: firstName, 
        LastName: lastName, 
        ClientApiIdentity: uniqueId, 
        Id: uniqueId, 
        ClientName: finalName,
        Mail: user.email || "no@mail.com", 
        Details: note || ""
    };

    let finalExpiry = "", currentCardDigits = "", usedToken = null;
    
    if (creditDetails) {
        tranData.CreditNum = creditDetails.num;
        // המרת MMYY ל-YYMM אם צריך, תלוי ב-API. כאן הנחתי סטנדרט
        finalExpiry = creditDetails.exp; 
        tranData.Expiry = finalExpiry;
        currentCardDigits = creditDetails.num.slice(-4);
    } else {
        usedToken = await getActiveToken(user);
        if (usedToken) {
            tranData.Token = fixToken(usedToken);
            const activeCard = user.cards.find(c => fixToken(c.token) === tranData.Token);
            if(activeCard) { tranData.Expiry = activeCard.expiry; currentCardDigits = activeCard.lastDigits; finalExpiry = activeCard.expiry; }
        } else { throw new Error("אין אמצעי תשלום"); }
    }

    try {
        const res = await axios.post('https://kesherhk.info/ConnectToKesher/ConnectToKesher', {
            Json: { userName: '2181420WS2087', password: 'WVmO1iterNb33AbWLzMjJEyVnEQbskSZqyel5T61Hb5qdwR0gl', func: "SendTransaction", format: "json", tran: sortObjectKeys(tranData) },
            format: "json"
        });

        // בדיקת תשובה מקשר
        const isSuccess = res.data.RequestResult?.Status === true || res.data.Status === true;
        const invoiceUrl = res.data.InvoiceUrl || res.data.RequestResult?.InvoiceUrl || "";
        const errorDesc = res.data.Description || res.data.RequestResult?.Description || "שגיאה לא ידועה";

        if(isSuccess) {
            // עדכון יעד גלובלי
            try { await Settings.findOneAndUpdate({}, { $inc: { goalCurrent: parseFloat(amount) } }, { upsert: true }); } catch(e){}
        }

        return { success: isSuccess, data: res.data, token: res.data.Token, finalExpiry, currentCardDigits, invoiceUrl, errorDesc };
    } catch (apiError) {
        console.error("Kesher API Error:", apiError);
        return { success: false, errorDesc: "תקלת תקשורת עם חברת האשראי" };
    }
}

// --- Routes ---
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/manager', (req, res) => res.sendFile(path.join(__dirname, 'admin.html')));

// כניסה + טעינת נתונים ראשוניים ללקוח
app.post('/login-by-id', async (req, res) => {
    try { 
        let user = await User.findById(req.body.userId);
        let settings = await Settings.findOne({});
        if(!settings) settings = { goalTitle: "יעד", goalTarget: 1000, goalCurrent: 0, goalVisible: true };
        
        if(user) {
            res.json({ success: true, user, settings }); 
        } else res.json({ success: false }); 
    } catch(e) { res.json({ success: false }); }
});

// תרומה
app.post('/donate', async (req, res) => {
    const { userId, amount, useToken, note, forceImmediate, ccDetails, providedPin } = req.body;
    let u = await User.findById(userId);
    
    // אימות PIN
    if (u.securityPin && u.securityPin.trim() !== "") { 
        if (String(providedPin).trim() !== String(u.securityPin).trim()) return res.json({ success: false, error: "קוד אבטחה (PIN) שגוי" }); 
    }
    
    let shouldChargeNow = (forceImmediate === true) ? true : (u.billingPreference === 0 && forceImmediate !== false);
    
    if (shouldChargeNow) {
        const r = await chargeKesher(u, amount, note, !useToken ? ccDetails : null);
        if (r.success) {
            u.totalDonated += parseFloat(amount);
            u.donationsHistory.push({ amount: parseFloat(amount), note, date: new Date(), status: 'success', invoiceUrl: r.invoiceUrl });
            await u.save();
            res.json({ success: true, message: "תרומה התקבלה!", invoiceUrl: r.invoiceUrl }); 
        } else { 
            u.donationsHistory.push({ amount: parseFloat(amount), note, date: new Date(), status: 'failed', failReason: r.errorDesc });
            await u.save();
            res.json({ success: false, error: r.errorDesc }); 
        }
    } else {
        u.pendingDonations.push({ amount: parseFloat(amount), note, date: new Date() });
        await u.save();
        res.json({ success: true, message: "נוסף לסל" });
    }
});

// ✅ רשימת לקוחות לאדמין (מהירה - ללא היסטוריה)
app.post('/admin/get-users', async (req, res) => {
    if(req.body.password !== "admin1234") return res.json({ success: false });
    try {
        // שולף רק שדות קריטיים לרשימה
        const users = await User.find({}, 'name phone email totalDonated bankDetails.status').sort({ _id: -1 }).lean(); 
        res.json({ success: true, users });
    } catch(e) { res.json({ success: false, error: e.message }); }
});

// ✅ שליפת לקוח מלא (כשלוחצים עליו)
app.post('/admin/get-user-full', async (req, res) => {
    if(req.body.password !== "admin1234") return res.json({ success: false });
    try {
        const user = await User.findById(req.body.targetId);
        res.json({ success: true, user });
    } catch(e) { res.json({ success: false }); }
});

// ✅ שמירת בנק
app.post('/submit-bank-mandate', async (req, res) => {
    const { userId, bankDetails, type } = req.body;
    try {
        let u = await User.findById(userId);
        if (!u) return res.json({ success: false, error: "משתמש לא נמצא" });
        if (!u.bankDetails) u.bankDetails = {};

        if (type === 'digital') {
            u.bankDetails = { type: 'digital', bankName: bankDetails.bankName, branch: bankDetails.branch, account: bankDetails.account, ownerName: bankDetails.ownerName, ownerID: bankDetails.ownerID, signatureImage: bankDetails.signature, status: 'pending', submitDate: new Date() };
        } else {
            u.bankDetails = { type: 'upload', uploadedProof: bankDetails.proofImage, status: 'pending', submitDate: new Date() };
        }
        await u.save();
        res.json({ success: true });
    } catch(e) { res.json({ success: false, error: e.message }); }
});

// עדכון פרופיל אדמין
app.post('/admin/update-profile', async (req, res) => {
    try {
        const { userId, name, phone, email, tz, receiptName, receiptTZ, billingPreference, recurringDailyAmount, recurringImmediate, securityPin, newCardDetails, canRemoveFromBasket, activeCardId, deleteCardId } = req.body;
        let u = await User.findById(userId);
        
        if(name) u.name = name; if(phone) u.phone = phone; if(email) u.email = email; if(tz) u.tz = tz;
        if(receiptName!==undefined) u.receiptName = receiptName;
        if(receiptTZ!==undefined) u.receiptTZ = receiptTZ;
        u.billingPreference = parseInt(billingPreference)||0;
        u.recurringDailyAmount = parseInt(recurringDailyAmount)||0;
        u.recurringImmediate = recurringImmediate===true;
        if(securityPin!==undefined) u.securityPin = securityPin;
        if(canRemoveFromBasket!==undefined) u.canRemoveFromBasket = canRemoveFromBasket;

        // כרטיסים
        if (deleteCardId) { 
            u.cards = u.cards.filter(c => c._id.toString() !== deleteCardId); 
            if(!u.cards.some(c=>c.active) && u.cards.length>0) u.cards[0].active=true; 
        }
        if (activeCardId) { u.cards.forEach(c => c.active = (c._id.toString() === activeCardId)); }
        
        if (newCardDetails) {
             const r = await chargeKesher(u, 0.1, "בדיקת כרטיס", newCardDetails);
             if (r.success || (r.errorDesc && r.errorDesc.includes("כפולה"))) {
                 u.cards.forEach(c=>c.active=false);
                 u.cards.push({ token: fixToken(r.token), lastDigits: r.currentCardDigits, expiry: r.finalExpiry, active: true });
             } else { return res.json({ success: false, error: r.errorDesc }); }
        }
        
        await u.save();
        res.json({ success: true });
    } catch(e) { res.status(500).json({ success: false, error: e.message }); }
});

// עדכון הגדרות מערכת (יעד)
app.post('/admin/update-settings', async (req, res) => {
    if(req.body.password !== "admin1234") return res.json({ success: false });
    await Settings.findOneAndUpdate({}, req.body, { upsert: true });
    res.json({ success: true });
});

app.post('/admin/get-settings', async (req, res) => {
    if(req.body.password !== "admin1234") return res.json({ success: false });
    let s = await Settings.findOne({});
    res.json({ success: true, settings: s || { goalTarget:1000, goalCurrent:0, goalVisible:true } });
});

// אימות מייל
app.post('/update-code', async (req, res) => {
    let { email, phone, code } = req.body;
    let cleanEmail = email ? email.toLowerCase().trim() : undefined;
    if (cleanEmail) { 
        try { await axios.post('https://api.emailjs.com/api/v1.0/email/send', { service_id: 'service_8f6h188', template_id: 'template_tzbq0k4', user_id: 'yLYooSdg891aL7etD', template_params: { email: cleanEmail, code: code }, accessToken: "b-Dz-J0Iq_yJvCfqX5Iw3" }); } catch (e) {} 
    }
    await User.findOneAndUpdate(cleanEmail ? { email: cleanEmail } : { phone: phone }, { tempCode: code, email: cleanEmail, phone: phone }, { upsert: true });
    res.json({ success: true });
});

app.post('/send-verification', async (req, res) => {
    const { email, code } = req.body;
    try {
        await axios.post('https://api.emailjs.com/api/v1.0/email/send', { service_id: 'service_8f6h188', template_id: 'template_tzbq0k4', user_id: 'yLYooSdg891aL7etD', template_params: { email, code }, accessToken: "b-Dz-J0Iq_yJvCfqX5Iw3" });
        res.json({ success: true });
    } catch(e) { res.json({ success: false }); }
});

app.post('/verify-auth', async (req, res) => {
    let { email, phone, code } = req.body;
    if(code === 'check') return res.json({ success: true });
    let u = await User.findOne(email ? { email: email.toLowerCase().trim() } : { phone: phone });
    if (u && String(u.tempCode).trim() === String(code).trim()) res.json({ success: true, user: u }); else res.json({ success: false });
});

app.post('/admin/approve-bank', async (req, res) => { await User.findByIdAndUpdate(req.body.userId, { "bankDetails.status": req.body.status }); res.json({ success: true }); });
app.post('/admin/delete-user', async (req, res) => { await User.findByIdAndDelete(req.body.userId); res.json({ success: true }); });
app.post('/delete-pending', async (req, res) => { await User.findByIdAndUpdate(req.body.userId, {$pull: {pendingDonations: {_id: req.body.donationId}}}); res.json({success:true}); });
app.post('/admin/stats', async (req, res) => { 
    if(req.body.password !== "admin1234") return res.json({ success: false });
    const total = await User.aggregate([{ $group: { _id: null, sum: { $sum: "$totalDonated" } } }]);
    res.json({ success: true, stats: { totalDonated: total[0]?.sum || 0, totalDonations: 0 } });
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`✅ Server Live`));
