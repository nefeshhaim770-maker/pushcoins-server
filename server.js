const express = require('express');
const cors = require('cors');
const axios = require('axios');
const mongoose = require('mongoose');
const admin = require('firebase-admin');
const cron = require('node-cron'); // חובה: מנהל את המשימות האוטומטיות היומיות
const path = require('path');
const app = express();

app.use(express.json());
app.use(cors());

// --- הגדרות Firebase ---
try {
    const serviceAccount = require('/etc/secrets/serviceAccountKey.json'); 
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
    console.log("✅ Firebase Initialized");
} catch (e) {
    try {
        const serviceAccount = require('./serviceAccountKey.json');
        admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
        console.log("✅ Firebase Local");
    } catch (err) { console.log("⚠️ No Firebase Key"); }
}

// --- חיבור ל-DB ---
mongoose.connect('mongodb+srv://nefeshhaim770_db_user:DxNzxIrIaoji0gWm@cluster0.njggbyd.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0')
    .then(() => console.log('✅ DB Connected'))
    .catch(err => console.error('❌ DB Error:', err));

// --- סכמת משתמש (מעודכנת) ---
const userSchema = new mongoose.Schema({
    email: String, phone: String, name: String, tz: String,
    lastExpiry: String, lastCardDigits: String, token: { type: String, default: "" },
    totalDonated: { type: Number, default: 0 },
    billingPreference: { type: Number, default: 0 }, // 0 = מיידי, 1-28 = יום בחודש
    recurringDailyAmount: { type: Number, default: 0 }, // סכום קבוע יומי
    securityPin: { type: String, default: "" }, // קוד אבטחה לתרומה
    fcmToken: { type: String, default: "" },
    donationsHistory: [{ amount: Number, date: { type: Date, default: Date.now }, note: String, status: String, failReason: String }],
    pendingDonations: [{ amount: Number, date: { type: Date, default: Date.now }, note: String }],
    tempCode: String
});
const User = mongoose.model('User', userSchema);

// --- פונקציות עזר ---
function fixToken(token) {
    if (!token) return "";
    let strToken = String(token).replace(/['"]+/g, '').trim();
    return (strToken.length > 0 && !strToken.startsWith('0')) ? '0' + strToken : strToken;
}
function sortObjectKeys(obj) { 
    return Object.keys(obj).sort().reduce((r, k) => { r[k] = obj[k]; return r; }, {}); 
}

// --- מנגנון הוראת קבע יומית (רץ כל יום ב-08:00) ---
cron.schedule('0 8 * * *', async () => {
    console.log('🔄 Running Daily Recurring Job...');
    try {
        const users = await User.find({ recurringDailyAmount: { $gt: 0 } });
        for (const u of users) {
            // אם המשתמש מוגדר לחיוב מיידי (0) ויש לו טוקן - מחייבים. אחרת - לסל.
            if(u.billingPreference === 0 && u.token) {
                try {
                    await chargeKesher(u, u.recurringDailyAmount, "הוראת קבע יומית");
                    u.totalDonated += u.recurringDailyAmount;
                    u.donationsHistory.push({ amount: u.recurringDailyAmount, note: "יומי קבוע", status: "success" });
                } catch(e) { console.error(`Failed charging user ${u._id}`); }
            } else {
                u.pendingDonations.push({ amount: u.recurringDailyAmount, note: "יומי קבוע" });
            }
            await u.save();
        }
        console.log(`✅ Processed daily donations for ${users.length} users.`);
    } catch(e) { console.error("Cron Error:", e); }
});

// --- פונקציית החיוב ---
async function chargeKesher(user, amount, note, cc = null) {
    const total = Math.round(parseFloat(amount) * 100);
    const phone = (user.phone || "0500000000").replace(/\D/g, '');
    const fullNameParts = (user.name || "Torem").trim().split(" ");
    const firstName = fullNameParts[0];
    const lastName = fullNameParts.length > 1 ? fullNameParts.slice(1).join(" ") : ".";

    let tran = {
        Total: total, Currency: 1, CreditType: 1, ParamJ: "J4", TransactionType: "debit", ProjectNumber: "00001",
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

// --- Routes ---
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/manager', (req, res) => res.sendFile(path.join(__dirname, 'admin.html')));
app.get('/firebase-messaging-sw.js', (req, res) => res.sendFile(path.join(__dirname, 'firebase-messaging-sw.js')));

// Client Routes
app.post('/update-code', async (req, res) => {
    let { email, phone, code } = req.body;
    let cleanEmail = email ? email.toLowerCase().trim() : undefined;
    let cleanPhone = phone ? phone.replace(/\D/g, '').trim() : undefined;
    if (cleanEmail) {
        try {
            await axios.post('https://api.emailjs.com/api/v1.0/email/send', {
                service_id: 'service_8f6h188', template_id: 'template_tzbq0k4', user_id: 'yLYooSdg891aL7etD',
                template_params: { email: cleanEmail, code: code }, accessToken: "b-Dz-J0Iq_yJvCfqX5Iw3"
            });
        } catch (e) {}
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
    try { 
        let user = await User.findById(req.body.userId);
        if(user) res.json({ success: true, user });
        else res.json({ success: false });
    } catch(e) { res.json({ success: false }); }
});

// ✅ פונקציית תרומה מתוקנת (כולל בדיקת PIN והפרדת סל)
app.post('/donate', async (req, res) => {
    const { userId, amount, useToken, note, forceImmediate, ccDetails, providedPin } = req.body;
    let u = await User.findById(userId);
    
    // 1. בדיקת PIN אם מוגדר
    if (u.securityPin && u.securityPin.trim() !== "") {
        if (providedPin !== u.securityPin) {
            return res.json({ success: false, error: "קוד אבטחה (PIN) שגוי" });
        }
    }

    // 2. החלטה האם לחייב
    // אם forceImmediate הוא true -> חייב מיד.
    // אם forceImmediate הוא false -> שלח לסל.
    const shouldChargeNow = forceImmediate === true;

    if (shouldChargeNow) {
        try {
            const r = await chargeKesher(u, amount, note, !useToken ? ccDetails : null);
            if (r.success) {
                if(r.data.Token) { 
                    u.token = fixToken(r.data.Token); 
                    u.lastExpiry = r.data.Expiry || ""; 
                    if(ccDetails) u.lastCardDigits = ccDetails.num.slice(-4);
                }
                u.totalDonated += parseFloat(amount);
                u.donationsHistory.push({ amount: parseFloat(amount), note, date: new Date(), status: 'success' });
                await u.save();
                res.json({ success: true, message: "תרומה התקבלה!" });
            } else {
                let err = r.data.Description || "סירוב לא ידוע";
                if (/Duplicate|double|כפולה/i.test(err)) err = "הסכום צריך להיות שונה שלא יחשב כתרומה כפולה";
                res.json({ success: false, error: err });
            }
        } catch(e) { res.json({ success: false, error: "תקלת תקשורת: " + e.message }); }
    } else {
        u.pendingDonations.push({ amount: parseFloat(amount), note, date: new Date() });
        await u.save();
        res.json({ success: true, message: "נוסף לסל בהצלחה" });
    }
});

// ✅ עדכון פרופיל (כולל השדות החדשים)
app.post('/admin/update-profile', async (req, res) => {
    await User.findByIdAndUpdate(req.body.userId, req.body);
    res.json({ success: true });
});

app.post('/save-push-token', async (req, res) => {
    await User.findByIdAndUpdate(req.body.userId, { fcmToken: req.body.token });
    res.json({ success: true });
});

app.post('/delete-pending', async (req, res) => {
    await User.findByIdAndUpdate(req.body.userId, { $pull: { pendingDonations: { _id: req.body.donationId } } });
    res.json({ success: true });
});

app.post('/reset-token', async (req, res) => {
    await User.findByIdAndUpdate(req.body.userId, { token: "", lastCardDigits: "" });
    res.json({ success: true });
});

// Admin API
const PASS = "admin1234";
app.post('/admin/stats', async (req, res) => {
    if(req.body.password !== PASS) return res.json({ success: false });
    const users = await User.find();
    let total = 0, count = 0;
    users.forEach(u => u.donationsHistory?.forEach(d => { if(d.status==='success') { total += d.amount||0; count++; } }));
    res.json({ success: true, stats: { totalDonated: total, totalUsers: users.length, totalDonations: count } });
});

app.post('/admin/get-users', async (req, res) => {
    if(req.body.password !== PASS) return res.json({ success: false });
    const users = await User.find().sort({ _id: -1 });
    res.json({ success: true, users });
});

app.post('/admin/update-user-full', async (req, res) => {
    if(req.body.password !== PASS) return res.json({ success: false });
    await User.findByIdAndUpdate(req.body.userId, req.body.userData);
    res.json({ success: true });
});

app.post('/admin/delete-user', async (req, res) => {
    if(req.body.password !== PASS) return res.json({ success: false });
    await User.findByIdAndDelete(req.body.userId);
    res.json({ success: true });
});

app.post('/admin/recalc-totals', async (req, res) => {
    if(req.body.password !== PASS) return res.json({ success: false });
    const users = await User.find();
    let c = 0;
    for (const u of users) {
        let t = 0;
        if(u.donationsHistory) u.donationsHistory.forEach(d => { if(d.status==='success') t += d.amount||0; });
        if(u.totalDonated !== t) { u.totalDonated = t; await u.save(); c++; }
    }
    res.json({ success: true, count: c });
});

app.post('/admin/send-push', async (req, res) => {
    if(req.body.password !== PASS) return res.json({ success: false });
    const users = await User.find({ fcmToken: { $exists: true, $ne: "" } });
    const tokens = users.map(u => u.fcmToken);
    if(tokens.length) {
        const response = await admin.messaging().sendMulticast({ notification: { title: req.body.title, body: req.body.body }, tokens });
        res.json({ success: true, sentCount: response.successCount });
    } else res.json({ success: false, error: "אין מכשירים" });
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`✅ Server Live on port ${PORT}`));
