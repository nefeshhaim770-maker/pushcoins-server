const express = require('express');
const cors = require('cors');
const axios = require('axios');
const mongoose = require('mongoose');
const admin = require('firebase-admin');
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

// --- סכמת משתמש ---
const userSchema = new mongoose.Schema({
    email: String, phone: String, name: String, tz: String,
    lastExpiry: String, lastCardDigits: String, token: { type: String, default: "" },
    totalDonated: { type: Number, default: 0 },
    billingPreference: { type: Number, default: 0 }, 
    recurringDailyAmount: { type: Number, default: 0 },
    securityPin: { type: String, default: "" },
    fcmToken: { type: String, default: "" },
    donationsHistory: [{ amount: Number, date: { type: Date, default: Date.now }, note: String, status: String, failReason: String }],
    pendingDonations: [{ amount: Number, date: { type: Date, default: Date.now }, note: String }],
    tempCode: String
});
const User = mongoose.model('User', userSchema);

// --- פונקציות תשלום ---
function sortObjectKeys(obj) { return Object.keys(obj).sort().reduce((r, k) => { r[k] = obj[k]; return r; }, {}); }

async function chargeKesher(user, amount, note, cc = null) {
    const total = Math.round(parseFloat(amount) * 100);
    const phone = (user.phone || "0500000000").replace(/\D/g, '');
    let tran = {
        Total: total, Currency: 1, CreditType: 1, ParamJ: "J4", TransactionType: "debit", ProjectNumber: "00001",
        Phone: phone, FirstName: user.name || "Torem", LastName: "Family", Mail: user.email || "no@mail.com",
        ClientApiIdentity: user.tz || "000000000", Id: user.tz || "000000000", Details: note || ""
    };

    if (cc) {
        tran.CreditNum = cc.num;
        tran.Expiry = (cc.exp.length === 4) ? cc.exp.substring(2, 4) + cc.exp.substring(0, 2) : cc.exp;
    } else if (user.token) {
        tran.Token = user.token.startsWith('0') ? user.token : '0' + user.token;
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

// לקוח
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
    if (u && u.tempCode == code) res.json({ success: true, user: u });
    else res.json({ success: false });
});

app.post('/login-by-id', async (req, res) => {
    try { res.json({ success: true, user: await User.findById(req.body.userId) }); } catch(e) { res.json({ success: false }); }
});

app.post('/donate', async (req, res) => {
    const { userId, amount, useToken, note, forceImmediate } = req.body;
    let u = await User.findById(userId);
    if (forceImmediate || u.billingPreference === 0) {
        try {
            const r = await chargeKesher(u, amount, note);
            if (r.success) {
                if(r.data.Token) { u.token = r.data.Token; u.lastExpiry = r.data.Expiry || ""; }
                u.totalDonated += parseFloat(amount);
                u.donationsHistory.push({ amount, note, status: 'success' });
                await u.save();
                res.json({ success: true, message: "תרומה התקבלה!" });
            } else res.json({ success: false, error: r.data.Description });
        } catch(e) { res.json({ success: false, error: "שגיאה בחיוב" }); }
    } else {
        u.pendingDonations.push({ amount, note });
        await u.save();
        res.json({ success: true, message: "נוסף לסל" });
    }
});

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

// אדמין
const PASS = "admin1234";
app.post('/admin/stats', async (req, res) => {
    if(req.body.password !== PASS) return res.json({ success: false });
    const users = await User.find();
    let total = 0;
    let count = 0; // מונה תרומות
    users.forEach(u => u.donationsHistory?.forEach(d => { 
        if(d.status==='success') {
            total += d.amount||0; 
            count++;
        }
    }));
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
    if(tokens.length) await admin.messaging().sendMulticast({ notification: { title: req.body.title, body: req.body.body }, tokens });
    res.json({ success: true, sentCount: tokens.length });
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`✅ Server Live`));
