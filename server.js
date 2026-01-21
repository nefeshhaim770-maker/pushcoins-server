const express = require('express');
const cors = require('cors');
const axios = require('axios');
const mongoose = require('mongoose');
const admin = require('firebase-admin');
const cron = require('node-cron');
const path = require('path');
const app = express();

app.use(express.json());
app.use(cors());

// --- הגדרות Firebase ---
try {
    const serviceAccount = require('/etc/secrets/serviceAccountKey.json'); 
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
} catch (e) {
    try {
        const serviceAccount = require('./serviceAccountKey.json');
        admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
    } catch (err) { console.log("⚠️ No Firebase Key"); }
}

// --- חיבור ל-DB ---
mongoose.connect('mongodb+srv://nefeshhaim770_db_user:DxNzxIrIaoji0gWm@cluster0.njggbyd.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0')
    .then(() => console.log('✅ DB Connected'))
    .catch(err => console.error('❌ DB Error:', err));

// --- סכמת משתמש ---
const userSchema = new mongoose.Schema({
    email: String, phone: String, name: String, tz: String,
    lastExpiry: String, lastCardDigits: String, token: { type: String, default: "" },
    totalDonated: { type: Number, default: 0 },
    billingPreference: { type: Number, default: 0 }, 
    recurringDailyAmount: { type: Number, default: 0 },
    recurringImmediate: { type: Boolean, default: false },
    securityPin: { type: String, default: "" },
    fcmToken: { type: String, default: "" },
    donationsHistory: [{ amount: Number, date: { type: Date, default: Date.now }, note: String, status: String, failReason: String }],
    pendingDonations: [{ amount: Number, date: { type: Date, default: Date.now }, note: String }],
    tempCode: String
});
const User = mongoose.model('User', userSchema);

// --- עזר ---
function fixToken(token) {
    if (!token) return "";
    let strToken = String(token).replace(/['"]+/g, '').trim();
    return (strToken.length > 0 && !strToken.startsWith('0')) ? '0' + strToken : strToken;
}
function sortObjectKeys(obj) { return Object.keys(obj).sort().reduce((r, k) => { r[k] = obj[k]; return r; }, {}); }

// --- מנוע חיוב ואימות (משודרג) ---
async function chargeKesher(user, amount, note, cc = null, isVerifyOnly = false) {
    const total = isVerifyOnly ? 0 : Math.round(parseFloat(amount) * 100);
    const phone = (user.phone || "0500000000").replace(/\D/g, '');
    const fullNameParts = (user.name || "Torem").trim().split(" ");
    const firstName = fullNameParts[0];
    const lastName = fullNameParts.length > 1 ? fullNameParts.slice(1).join(" ") : ".";

    // הגדרת סוג הפעולה: J4 לחיוב, J5 לבדיקה/שמירה בלבד
    const paramJ = isVerifyOnly ? "J5" : "J4";
    const transType = isVerifyOnly ? "check" : "debit";

    let tran = {
        Total: total, Currency: 1, CreditType: 1, 
        ParamJ: paramJ, 
        TransactionType: transType, 
        ProjectNumber: "00001",
        Phone: phone, FirstName: firstName, LastName: lastName, Mail: user.email || "no@mail.com",
        ClientApiIdentity: user.tz || "000000000", Id: user.tz || "000000000", Details: note || ""
    };

    if (cc) {
        tran.CreditNum = cc.num;
        tran.Expiry = (cc.exp.length === 4) ? cc.exp.substring(2, 4) + cc.exp.substring(0, 2) : cc.exp;
    } else if (user.token) {
        tran.Token = fixToken(user.token);
        tran.Expiry = user.lastExpiry;
    } else throw new Error("No Payment Method");

    const res = await axios.post('https://kesherhk.info/ConnectToKesher/ConnectToKesher', {
        Json: { userName: '2181420WS2087', password: 'WVmO1iterNb33AbWLzMjJEyVnEQbskSZqyel5T61Hb5qdwR0gl', func: "SendTransaction", format: "json", tran: sortObjectKeys(tran) },
        format: "json"
    }, { validateStatus: () => true });

    return { success: res.data.RequestResult?.Status === true || res.data.Status === true, data: res.data };
}

// --- Cron Job (08:00) ---
cron.schedule('0 8 * * *', async () => {
    const now = new Date();
    const today = now.getDate();
    const lastDayOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
    const isLastDay = (today === lastDayOfMonth);
    const users = await User.find({}); 

    for (const u of users) {
        let saveUser = false;

        // יומי
        if (u.recurringDailyAmount > 0) {
            if (u.recurringImmediate === true || u.billingPreference === 0) {
                if(u.token) {
                    try {
                        await chargeKesher(u, u.recurringDailyAmount, "הוראת קבע יומית");
                        u.totalDonated += u.recurringDailyAmount;
                        u.donationsHistory.push({ amount: u.recurringDailyAmount, note: "יומי קבוע (מיידי)", status: "success" });
                    } catch(e) {
                        u.donationsHistory.push({ amount: u.recurringDailyAmount, note: "יומי קבוע", status: "failed", failReason: "תקלה" });
                    }
                    saveUser = true;
                }
            } else {
                u.pendingDonations.push({ amount: u.recurringDailyAmount, note: "יומי קבוע (הצטברות)" });
                saveUser = true;
            }
        }

        // חודשי
        let shouldChargeMonthly = (u.billingPreference === today) || (isLastDay && u.billingPreference > lastDayOfMonth);

        if (shouldChargeMonthly && u.pendingDonations.length > 0) {
            let totalToCharge = 0;
            u.pendingDonations.forEach(d => totalToCharge += d.amount);
            
            if (totalToCharge > 0 && u.token) {
                try {
                    await chargeKesher(u, totalToCharge, "חיוב סל חודשי מרוכז");
                    u.totalDonated += totalToCharge;
                    u.pendingDonations.forEach(d => {
                        u.donationsHistory.push({ amount: d.amount, note: d.note, status: "success", date: new Date() });
                    });
                    u.pendingDonations = [];
                } catch (e) {}
                saveUser = true;
            }
        }
        if (saveUser) await u.save();
    }
});

// --- Routes ---
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/manager', (req, res) => res.sendFile(path.join(__dirname, 'admin.html')));
app.get('/firebase-messaging-sw.js', (req, res) => res.sendFile(path.join(__dirname, 'firebase-messaging-sw.js')));

app.post('/update-code', async (req, res) => {
    let { email, phone, code } = req.body;
    let cleanEmail = email ? email.toLowerCase().trim() : undefined;
    let cleanPhone = phone ? phone.replace(/\D/g, '').trim() : undefined;
    if (cleanEmail) {
        try { await axios.post('https://api.emailjs.com/api/v1.0/email/send', { service_id: 'service_8f6h188', template_id: 'template_tzbq0k4', user_id: 'yLYooSdg891aL7etD', template_params: { email: cleanEmail, code: code }, accessToken: "b-Dz-J0Iq_yJvCfqX5Iw3" }); } catch (e) {}
    }
    await User.findOneAndUpdate(cleanEmail ? { email: cleanEmail } : { phone: cleanPhone }, { tempCode: code, email: cleanEmail, phone: cleanPhone }, { upsert: true });
    res.json({ success: true });
});

app.post('/verify-auth', async (req, res) => {
    let { email, phone, code } = req.body;
    if(code === 'check') return res.json({ success: true });
    let u = await User.findOne(email ? { email: email.toLowerCase().trim() } : { phone: phone.replace(/\D/g, '').trim() });
    if (u && String(u.tempCode).trim() === String(code).trim()) res.json({ success: true, user: u });
    else res.json({ success: false });
});

app.post('/login-by-id', async (req, res) => {
    try { let user = await User.findById(req.body.userId); if(user) res.json({ success: true, user }); else res.json({ success: false }); } catch(e) { res.json({ success: false }); }
});

app.post('/donate', async (req, res) => {
    const { userId, amount, useToken, note, forceImmediate, ccDetails, providedPin } = req.body;
    let u = await User.findById(userId);
    
    if (!u.name || !u.phone || !u.email || !u.tz) return res.json({ success: false, error: "חסרים פרטים אישיים (שם, טלפון, מייל, ת\"ז). נא לעדכן בהגדרות." });

    if (u.securityPin && u.securityPin.trim() !== "") {
        if (String(providedPin).trim() !== String(u.securityPin).trim()) return res.json({ success: false, error: "קוד אבטחה (PIN) שגוי" });
    }

    let shouldChargeNow = (forceImmediate === true) ? true : (u.billingPreference === 0 && forceImmediate !== false);

    if (shouldChargeNow) {
        try {
            const r = await chargeKesher(u, amount, note, !useToken ? ccDetails : null);
            if (r.success) {
                if(r.data.Token) { u.token = fixToken(r.data.Token); u.lastExpiry = r.data.Expiry || ""; if(ccDetails) u.lastCardDigits = ccDetails.num.slice(-4); }
                u.totalDonated += parseFloat(amount);
                u.donationsHistory.push({ amount: parseFloat(amount), note, date: new Date(), status: 'success' });
                await u.save();
                res.json({ success: true, message: "תרומה התקבלה!" });
            } else {
                let err = r.data.Description || "סירוב לא ידוע";
                if (/Duplicate|double|כפולה/i.test(err)) err = "הסכום צריך להיות שונה שלא יחשב כתרומה כפולה";
                res.json({ success: false, error: err });
            }
        } catch(e) { res.json({ success: false, error: "תקלת תקשורת" }); }
    } else {
        u.pendingDonations.push({ amount: parseFloat(amount), note, date: new Date() });
        await u.save();
        res.json({ success: true, message: "נוסף לסל" });
    }
});

// ✅ שמירת כרטיס עם J5 (ללא חיוב)
app.post('/admin/update-profile', async (req, res) => {
    try {
        const { userId, name, phone, email, tz, billingPreference, recurringDailyAmount, securityPin, recurringImmediate, newCardDetails } = req.body;
        
        if (!name || !phone || !email || !tz) return res.json({ success: false, error: "חובה למלא: שם, טלפון, מייל ותעודת זהות" });

        let updateData = {
            name, phone, email, tz,
            billingPreference: parseInt(billingPreference) || 0, 
            recurringDailyAmount: parseInt(recurringDailyAmount) || 0,
            recurringImmediate: recurringImmediate === true, 
            securityPin
        };

        let u = await User.findById(userId);
        
        // אם יש כרטיס חדש - בצע J5 (בדיקת מסגרת ללא חיוב)
        if (newCardDetails && newCardDetails.num && newCardDetails.exp) {
            try {
                u.name = name; u.phone = phone; u.email = email; u.tz = tz;
                // isVerifyOnly = true
                const r = await chargeKesher(u, 0, "שמירת כרטיס (J5)", newCardDetails, true);
                
                if (r.success && r.data.Token) {
                    updateData.token = fixToken(r.data.Token);
                    updateData.lastExpiry = r.data.Expiry || "";
                    updateData.lastCardDigits = newCardDetails.num.slice(-4);
                    // לא מוסיפים לתרומות כי זה לא חיוב
                } else {
                    return res.json({ success: false, error: "אימות כרטיס נכשל (J5)" });
                }
            } catch(e) { return res.json({ success: false, error: "תקלה בשמירת הכרטיס" }); }
        }

        Object.assign(u, updateData);
        await u.save();
        res.json({ success: true });

    } catch(e) { res.status(500).json({ success: false, error: e.message }); }
});

app.post('/save-push-token', async (req, res) => { await User.findByIdAndUpdate(req.body.userId, { fcmToken: req.body.token }); res.json({ success: true }); });
app.post('/delete-pending', async (req, res) => { await User.findByIdAndUpdate(req.body.userId, { $pull: { pendingDonations: { _id: req.body.donationId } } }); res.json({ success: true }); });
app.post('/reset-token', async (req, res) => { await User.findByIdAndUpdate(req.body.userId, { token: "", lastCardDigits: "" }); res.json({ success: true }); });

const PASS = "admin1234";
app.post('/admin/stats', async (req, res) => {
    if(req.body.password !== PASS) return res.json({ success: false }); 
    const users = await User.find();
    let total = 0, count = 0;
    users.forEach(u => u.donationsHistory?.forEach(d => { if(d.status==='success') { total += d.amount||0; count++; } }));
    res.json({ success: true, stats: { totalDonated: total, totalUsers: users.length, totalDonations: count } });
});
app.post('/admin/get-users', async (req, res) => { if(req.body.password !== PASS) return res.json({ success: false }); const users = await User.find().sort({ _id: -1 }); res.json({ success: true, users }); });
app.post('/admin/update-user-full', async (req, res) => { if(req.body.password !== PASS) return res.json({ success: false }); await User.findByIdAndUpdate(req.body.userId, req.body.userData); res.json({ success: true }); });
app.post('/admin/delete-user', async (req, res) => { if(req.body.password !== PASS) return res.json({ success: false }); await User.findByIdAndDelete(req.body.userId); res.json({ success: true }); });
app.post('/admin/recalc-totals', async (req, res) => { if(req.body.password !== PASS) return res.json({ success: false }); const users = await User.find(); let c=0; for (const u of users) { let t=0; if(u.donationsHistory) u.donationsHistory.forEach(d => { if(d.status==='success') t += d.amount||0; }); if(u.totalDonated!==t) { u.totalDonated=t; await u.save(); c++; } } res.json({ success: true, count: c }); });
app.post('/admin/send-push', async (req, res) => { if(req.body.password !== PASS) return res.json({ success: false }); const users = await User.find({ fcmToken: { $exists: true, $ne: "" } }); const tokens = users.map(u => u.fcmToken); if(tokens.length) { const response = await admin.messaging().sendMulticast({ notification: { title: req.body.title, body: req.body.body }, tokens }); res.json({ success: true, sentCount: response.successCount }); } else res.json({ success: false, error: "אין מכשירים" }); });

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`✅ Server Live`));
