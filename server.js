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

// --- 1. הגדרות Firebase ---
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

// --- 2. חיבור ל-DB ---
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

function sortObjectKeys(obj) {
    return Object.keys(obj).sort().reduce((result, key) => { result[key] = obj[key]; return result; }, {});
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
        Json: { userName: '2181420WS2087', password: 'WVmO1iterNb33AbWLzMjJEyVnEQbskSZqyel5T61Hb5qdwR0gl', func: "SendTransaction", format: "json", tran: sortObjectKeys(tranData) },
        format: "json"
    }, { validateStatus: () => true });

    const isSuccess = response.data.RequestResult?.Status === true || response.data.Status === true;
    return { isSuccess, resData: response.data, currentCardDigits, finalExpiry };
}

// --- 5. נתיבים (Routes) ---
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/manager', (req, res) => res.sendFile(path.join(__dirname, 'admin.html')));
app.get('/firebase-messaging-sw.js', (req, res) => res.sendFile(path.join(__dirname, 'firebase-messaging-sw.js')));

// Auth & App Routes
app.post('/update-code', async (req, res) => {
    let { email, phone, code } = req.body;
    let cleanEmail = email ? email.toLowerCase().trim() : undefined;
    let cleanPhone = phone ? phone.replace(/\D/g, '').trim() : undefined;
    console.log(`🔑 LOGIN CODE: ${code}`);

    if (cleanEmail) {
        try {
            await axios.post('https://api.emailjs.com/api/v1.0/email/send', {
                service_id: 'service_8f6h188',
                template_id: 'template_tzbq0k4',
                user_id: 'yLYooSdg891aL7etD',
                template_params: { email: cleanEmail, code: code },
                accessToken: "b-Dz-J0Iq_yJvCfqX5Iw3"
            });
        } catch (e) { console.error("Email Error:", e.message); }
    }
    await User.findOneAndUpdate(cleanEmail ? { email: cleanEmail } : { phone: cleanPhone }, 
        { $set: { tempCode: code, email: cleanEmail, phone: cleanPhone } }, { upsert: true, new: true });
    res.json({ success: true });
});

app.post('/verify-auth', async (req, res) => {
    let { email, phone, code } = req.body;
    if(code === 'check') return res.json({ success: true });
    let user = await User.findOne(email ? { email: email.toLowerCase().trim() } : { phone: phone.replace(/\D/g, '').trim() });
    if (user && String(user.tempCode).trim() === String(code).trim()) res.json({ success: true, user });
    else res.json({ success: false });
});

app.post('/login-by-id', async (req, res) => {
    try { res.json({ success: true, user: await User.findById(req.body.userId) }); } catch (e) { res.json({ success: false }); }
});

app.post('/update-profile', async (req, res) => {
    await User.findByIdAndUpdate(req.body.userId, req.body);
    res.json({ success: true });
});

app.post('/save-push-token', async (req, res) => {
    await User.findByIdAndUpdate(req.body.userId, { fcmToken: req.body.token });
    res.json({ success: true });
});

app.post('/donate', async (req, res) => {
    const { userId, amount, useToken, note, forceImmediate, ccDetails } = req.body;
    let user = await User.findById(userId);
    const chargeNow = user.billingPreference === 0 || forceImmediate || (!useToken && ccDetails);

    if (chargeNow) {
        const result = await chargeKesher(user, amount, note, !useToken ? ccDetails : null);
        if (result.isSuccess) {
            if(!useToken && result.resData.Token) {
                user.token = fixToken(result.resData.Token);
                user.lastCardDigits = result.currentCardDigits;
            }
            user.totalDonated += parseFloat(amount);
            user.donationsHistory.push({ amount: parseFloat(amount), note, date: new Date(), status: 'success' });
            await user.save();
            res.json({ success: true, message: "בוצע בהצלחה" });
        } else {
            res.json({ success: false, error: result.resData.Description });
        }
    } else {
        user.pendingDonations.push({ amount: parseFloat(amount), note, date: new Date() });
        await user.save();
        res.json({ success: true, message: "נוסף לסל" });
    }
});

app.post('/delete-pending', async (req, res) => {
    await User.findByIdAndUpdate(req.body.userId, { $pull: { pendingDonations: { _id: req.body.donationId } } });
    res.json({ success: true });
});

app.post('/reset-token', async (req, res) => {
    await User.findByIdAndUpdate(req.body.userId, { token: "", lastCardDigits: "" });
    res.json({ success: true });
});


// --- ADMIN ROUTES (חשוב מאוד!) ---
const ADMIN_PASS = "admin1234";

app.post('/admin/stats', async (req, res) => {
    if(req.body.password !== ADMIN_PASS) return res.json({success: false});
    const users = await User.find();
    let total = 0; users.forEach(u => u.donationsHistory?.forEach(d => { if(d.status==='success') total += d.amount || 0; }));
    res.json({ success: true, stats: { totalDonated: total, totalUsers: users.length } });
});

app.post('/admin/get-users', async (req, res) => {
    if(req.body.password !== ADMIN_PASS) return res.json({success: false});
    const users = await User.find().sort({ _id: -1 }); // הכי חדשים למעלה
    res.json({ success: true, users });
});

app.post('/admin/delete-user', async (req, res) => {
    if (req.body.password !== ADMIN_PASS) return res.status(403).json({ success: false });
    await User.findByIdAndDelete(req.body.userId);
    res.json({ success: true });
});

app.post('/admin/update-user-full', async (req, res) => {
    if (req.body.password !== ADMIN_PASS) return res.status(403).json({ success: false });
    await User.findByIdAndUpdate(req.body.userId, req.body.userData);
    res.json({ success: true });
});

app.post('/admin/recalc-totals', async (req, res) => {
    if (req.body.password !== ADMIN_PASS) return res.status(403).json({ success: false });
    try {
        const users = await User.find();
        let updatedCount = 0;
        for (const user of users) {
            let realTotal = 0;
            if(user.donationsHistory) {
                user.donationsHistory.forEach(d => {
                    if(d.status === 'success') realTotal += (d.amount || 0);
                });
            }
            if(user.totalDonated !== realTotal) {
                user.totalDonated = realTotal;
                await user.save();
                updatedCount++;
            }
        }
        res.json({ success: true, count: updatedCount });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.post('/admin/send-push', async (req, res) => {
    if(req.body.password !== ADMIN_PASS) return res.json({success: false});
    const users = await User.find({ fcmToken: { $exists: true, $ne: "" } });
    const tokens = users.map(u => u.fcmToken);
    if(tokens.length === 0) return res.json({ success: false, error: "אין מכשירים" });
    const response = await admin.messaging().sendMulticast({ notification: { title: req.body.title, body: req.body.body }, tokens });
    res.json({ success: true, sentCount: response.successCount });
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));
