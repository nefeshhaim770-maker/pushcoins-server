const express = require('express');
const cors = require('cors');
const axios = require('axios');
const mongoose = require('mongoose');
const cron = require('node-cron');
const admin = require('firebase-admin');
const path = require('path');
const app = express();

app.use(express.json());
app.use(cors());

// --- 1. הגדרת Firebase (הודעות פוש) ---
try {
    const serviceAccount = require('/etc/secrets/serviceAccountKey.json'); 
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
    console.log("✅ Firebase Admin Initialized");
} catch (error) {
    try {
        const serviceAccount = require('./serviceAccountKey.json');
        admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
        console.log("✅ Firebase Admin Initialized (Local)");
    } catch (e) { console.log("⚠️ Warning: Firebase key not found."); }
}

// --- 2. חיבור למסד הנתונים ---
mongoose.connect('mongodb+srv://nefeshhaim770_db_user:DxNzxIrIaoji0gWm@cluster0.njggbyd.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0')
    .then(() => console.log('✅ MongoDB Connected'))
    .catch(err => console.error('❌ MongoDB Error:', err));

// --- 3. סכמת משתמש ---
const userSchema = new mongoose.Schema({
    email: { type: String, sparse: true },
    phone: { type: String, sparse: true },
    name: String,
    tz: String,
    lastExpiry: String,
    lastCardDigits: String,
    token: { type: String, default: "" },
    totalDonated: { type: Number, default: 0 },
    billingPreference: { type: Number, default: 0 }, 
    recurringDailyAmount: { type: Number, default: 0 },
    securityPin: { type: String, default: "" }, 
    fcmToken: { type: String, default: "" },
    donationsHistory: [{
        amount: Number, date: { type: Date, default: Date.now }, note: String,
        status: { type: String, default: 'success' }, failReason: String, cardDigits: String
    }],
    pendingDonations: [{
        _id: { type: mongoose.Schema.Types.ObjectId, auto: true },
        amount: Number, date: { type: Date, default: Date.now }, note: String
    }],
    tempCode: String
});
const User = mongoose.model('User', userSchema);

// --- 4. פונקציות עזר וחיוב ---
function fixToken(token) {
    if (!token) return "";
    let strToken = String(token).replace(/['"]+/g, '').trim();
    return (strToken.length > 0 && !strToken.startsWith('0')) ? '0' + strToken : strToken;
}

async function chargeKesher(user, amount, note, creditDetails = null) {
    const amountInAgorot = Math.round(parseFloat(amount) * 100);
    const realIdToSend = user.tz || "000000000";
    const safePhone = (user.phone || "0500000000").replace(/\D/g, '');

    let tranData = {
        Total: amountInAgorot, Currency: 1, CreditType: 1, ParamJ: "J4", TransactionType: "debit", ProjectNumber: "00001",
        Phone: safePhone, FirstName: (user.name || "Torem").split(" ")[0], LastName: (user.name || "").split(" ").slice(1).join(" ") || "Family",
        Mail: user.email || "no-email@test.com", ClientApiIdentity: realIdToSend, Id: realIdToSend, Details: note || ""
    };

    let finalExpiry = user.lastExpiry;
    let currentCardDigits = user.lastCardDigits;

    if (creditDetails) {
        tranData.CreditNum = creditDetails.num;
        finalExpiry = (creditDetails.exp.length === 4) ? creditDetails.exp.substring(2, 4) + creditDetails.exp.substring(0, 2) : creditDetails.exp;
        tranData.Expiry = finalExpiry;
        currentCardDigits = creditDetails.num.slice(-4);
    } else if (user.token) {
        tranData.Token = fixToken(user.token);
        tranData.Expiry = user.lastExpiry;
    } else { throw new Error("חסר אמצעי תשלום"); }

    const response = await axios.post('https://kesherhk.info/ConnectToKesher/ConnectToKesher', {
        Json: { userName: '2181420WS2087', password: 'WVmO1iterNb33AbWLzMjJEyVnEQbskSZqyel5T61Hb5qdwR0gl', func: "SendTransaction", format: "json", tran: tranData },
        format: "json"
    }, { validateStatus: () => true });

    return { isSuccess: response.data.RequestResult?.Status === true || response.data.Status === true, resData: response.data, currentCardDigits, finalExpiry };
}

// --- 5. מסלולים (Routes) ---
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/manager', (req, res) => res.sendFile(path.join(__dirname, 'admin.html')));

// שליחת קוד (עם גיבוי לוגים)
app.post('/update-code', async (req, res) => {
    let { email, phone, code } = req.body;
    try {
        let cleanEmail = email ? email.toLowerCase().trim() : undefined;
        let cleanPhone = phone ? phone.replace(/\D/g, '').trim() : undefined;
        const query = cleanEmail ? { email: cleanEmail } : { phone: cleanPhone };
        
        // ⚠️ הדפסה ללוגים ב-Render למקרה שהמייל לא עובד
        console.log(`🔑 LOGIN CODE for ${cleanEmail || cleanPhone}: ${code}`);

        if (cleanEmail) {
            try {
                // שים לב: זה דורש מפתחות EmailJS תקינים משלך!
                await axios.post('https://api.emailjs.com/api/v1.0/email/send', {
                    service_id: 'service_8f6h188', // וודא שזה ה-ID שלך
                    template_id: 'template_tzbq0k4', // וודא שזה ה-ID שלך
                    user_id: 'yLYooSdg891aL7etD',    // וודא שזה ה-Public Key שלך
                    template_params: { email: cleanEmail, code: code },
                    accessToken: "b-Dz-J0Iq_yJvCfqX5Iw3" // וודא שזה ה-Private Key שלך
                });
            } catch (e) {
                console.error("❌ Email sending failed (check your keys):", e.message);
            }
        }
        
        await User.findOneAndUpdate(query, { $set: { tempCode: code, email: cleanEmail, phone: cleanPhone } }, { upsert: true, new: true });
        res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false }); }
});

app.post('/verify-auth', async (req, res) => {
    let { email, phone, code } = req.body;
    try {
        if (code === 'check') return res.json({ success: true });
        const query = email ? { email: email.toLowerCase().trim() } : { phone: phone.replace(/\D/g, '').trim() };
        let user = await User.findOne(query);
        if (user && String(user.tempCode).trim() === String(code).trim()) res.json({ success: true, user });
        else res.json({ success: false, error: "קוד שגוי" });
    } catch (e) { res.status(500).json({ success: false }); }
});

app.post('/login-by-id', async (req, res) => {
    try { let user = await User.findById(req.body.userId); res.json({ success: !!user, user }); } 
    catch (e) { res.status(500).json({ success: false }); }
});

app.post('/update-profile', async (req, res) => {
    try {
        await User.findByIdAndUpdate(req.body.userId, req.body, { new: true });
        res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false }); }
});

app.post('/donate', async (req, res) => {
    const { userId, amount, ccDetails, useToken, note, forceImmediate } = req.body;
    try {
        let user = await User.findById(userId);
        if (!user) return res.status(404).json({ success: false });

        const shouldChargeNow = user.billingPreference === 0 || forceImmediate === true || (!useToken && ccDetails);

        if (shouldChargeNow) {
            const result = await chargeKesher(user, amount, note, !useToken ? ccDetails : null);
            if (result.isSuccess) {
                if (!useToken && result.resData.Token) {
                    user.token = fixToken(result.resData.Token);
                    user.lastCardDigits = result.currentCardDigits;
                    user.lastExpiry = result.finalExpiry;
                }
                user.totalDonated += parseFloat(amount);
                user.donationsHistory.push({ amount: parseFloat(amount), note, date: new Date(), status: 'success' });
                await user.save();
                res.json({ success: true, message: "התרומה בוצעה בהצלחה!" });
            } else {
                user.donationsHistory.push({ amount: parseFloat(amount), note, date: new Date(), status: 'failed', failReason: result.resData.Description });
                await user.save();
                res.status(400).json({ success: false, error: result.resData.Description });
            }
        } else {
            user.pendingDonations.push({ amount: parseFloat(amount), note, date: new Date() });
            await user.save();
            res.json({ success: true, message: "התווסף לסל!" });
        }
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// --- ADMIN ---
const ADMIN_PASSWORD = "admin1234";

app.post('/admin/login', (req, res) => {
    if (req.body.password === ADMIN_PASSWORD) res.json({ success: true });
    else res.json({ success: false });
});

app.post('/admin/stats', async (req, res) => {
    if (req.body.password !== ADMIN_PASSWORD) return res.status(403).json({ success: false });
    try {
        const totalUsers = await User.countDocuments();
        const users = await User.find();
        let totalDonated = 0, totalDonationsCount = 0, monthlyDonated = 0;
        const now = new Date();
        users.forEach(u => u.donationsHistory?.forEach(d => {
            if (d.status === 'success') {
                totalDonated += (d.amount || 0);
                totalDonationsCount++;
                if (new Date(d.date).getMonth() === now.getMonth()) monthlyDonated += (d.amount || 0);
            }
        }));
        res.json({ success: true, stats: { totalUsers, totalDonated, totalDonationsCount, monthlyDonated } });
    } catch (e) { res.status(500).json({ success: false }); }
});

app.post('/admin/get-users', async (req, res) => {
    if (req.body.password !== ADMIN_PASSWORD) return res.status(403).json({ success: false });
    const regex = new RegExp(req.body.searchQuery || '', 'i');
    const users = await User.find({ $or: [{ name: regex }, { email: regex }, { phone: regex }] }).sort({ totalDonated: -1 });
    res.json({ success: true, users });
});

app.post('/admin/update-user-full', async (req, res) => {
    if (req.body.password !== ADMIN_PASSWORD) return res.status(403).json({ success: false });
    await User.findByIdAndUpdate(req.body.userId, req.body.userData);
    res.json({ success: true });
});

app.post('/admin/delete-user', async (req, res) => {
    if (req.body.password !== ADMIN_PASSWORD) return res.status(403).json({ success: false });
    await User.findByIdAndDelete(req.body.userId);
    res.json({ success: true });
});

app.post('/admin/send-push', async (req, res) => {
    if (req.body.password !== ADMIN_PASSWORD) return res.status(403).json({ success: false });
    try {
        const users = await User.find({ fcmToken: { $exists: true, $ne: "" } });
        const tokens = users.map(u => u.fcmToken);
        if (tokens.length === 0) return res.json({ success: false, error: "אין משתמשים" });

        const response = await admin.messaging().sendMulticast({
            notification: { title: req.body.title, body: req.body.body },
            tokens: tokens
        });
        res.json({ success: true, sentCount: response.successCount });
    } catch (e) { res.status(500).json({ success: false, error: "שגיאה בשליחה" }); }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`✅ Server Live`));
