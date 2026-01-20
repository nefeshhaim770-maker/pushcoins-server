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

// --- Firebase ---
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

// --- MongoDB ---
mongoose.connect('mongodb+srv://nefeshhaim770_db_user:DxNzxIrIaoji0gWm@cluster0.njggbyd.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0')
    .then(() => console.log('✅ MongoDB Connected'))
    .catch(err => console.error('❌ MongoDB Error:', err));

// --- Schema ---
const userSchema = new mongoose.Schema({
    email: { type: String, sparse: true },
    phone: { type: String, sparse: true },
    name: String,
    tz: String,
    lastExpiry: String,
    lastCardDigits: String,
    token: { type: String, default: "" },
    totalDonated: { type: Number, default: 0 },
    billingPreference: { type: Number, default: 0 }, // 0=Immediate, 2/10=Monthly
    recurringDailyAmount: { type: Number, default: 0 },
    securityPin: { type: String, default: "" }, // קוד PIN לתרומה
    fcmToken: { type: String, default: "" },
    donationsHistory: [{
        amount: Number,
        date: { type: Date, default: Date.now },
        note: String,
        status: { type: String, default: 'success' }, 
        failReason: String,
        cardDigits: String
    }],
    pendingDonations: [{
        _id: { type: mongoose.Schema.Types.ObjectId, auto: true },
        amount: Number,
        date: { type: Date, default: Date.now },
        note: String
    }],
    tempCode: String
});
const User = mongoose.model('User', userSchema);

// --- Helpers ---
function sortObjectKeys(obj) {
    return Object.keys(obj).sort().reduce((result, key) => { result[key] = obj[key]; return result; }, {});
}
function fixToken(token) {
    if (!token) return "";
    let strToken = String(token).replace(/['"]+/g, '').trim();
    return (strToken.length > 0 && !strToken.startsWith('0')) ? '0' + strToken : strToken;
}

// --- Charge Function ---
async function chargeKesher(user, amount, note, creditDetails = null) {
    const amountInAgorot = Math.round(parseFloat(amount) * 100);
    const realIdToSend = user.tz || "000000000";
    const safePhone = (user.phone || "0500000000").replace(/\D/g, '');

    let tranData = {
        Total: amountInAgorot,
        Currency: 1, CreditType: 1, ParamJ: "J4", TransactionType: "debit", ProjectNumber: "00001",
        Phone: safePhone,
        FirstName: (user.name || "Torem").split(" ")[0],
        LastName: (user.name || "").split(" ").slice(1).join(" ") || "Family",
        Mail: user.email || "no-email@test.com",
        ClientApiIdentity: realIdToSend, Id: realIdToSend, Details: note || ""
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

    const resData = response.data;
    const isSuccess = resData.RequestResult?.Status === true || resData.Status === true;
    return { isSuccess, resData, currentCardDigits, finalExpiry };
}

// --- Cron Jobs ---
cron.schedule('0 7 * * *', async () => { /* Daily Cron Logic (Same as before) */ });
cron.schedule('0 9 2,10 * *', async () => { /* Monthly Cron Logic (Same as before) */ });

// --- API Routes ---
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/manager', (req, res) => res.sendFile(path.join(__dirname, 'admin.html')));

// Auth & Profile
app.post('/update-code', async (req, res) => {
    let { email, phone, code } = req.body;
    try {
        let cleanEmail = email ? email.toLowerCase().trim() : undefined;
        let cleanPhone = phone ? phone.replace(/\D/g, '').trim() : undefined;
        const query = cleanEmail ? { email: cleanEmail } : { phone: cleanPhone };
        
        // EmailJS logic here... (Same as before)
        
        await User.findOneAndUpdate(query, { $set: { tempCode: code, email: cleanEmail, phone: cleanPhone } }, { upsert: true, new: true });
        res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false }); }
});

app.post('/verify-auth', async (req, res) => { /* Same as before */ });

app.post('/login-by-id', async (req, res) => {
    try {
        let user = await User.findById(req.body.userId);
        res.json({ success: !!user, user });
    } catch (e) { res.status(500).json({ success: false }); }
});

// ✅ עדכון פרופיל משתמש (מהלקוח)
app.post('/update-profile', async (req, res) => {
    const { userId, name, email, phone, tz, securityPin } = req.body;
    try {
        let updateData = {};
        if (name) updateData.name = name;
        if (email) updateData.email = email;
        if (phone) updateData.phone = phone;
        if (tz) updateData.tz = tz;
        if (securityPin !== undefined) updateData.securityPin = securityPin; // עדכון PIN

        const user = await User.findByIdAndUpdate(userId, updateData, { new: true });
        res.json({ success: true, user });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ✅ איפוס טוקן (החלפת אשראי)
app.post('/reset-token', async (req, res) => {
    try {
        await User.findByIdAndUpdate(req.body.userId, { token: "", lastCardDigits: "", lastExpiry: "" });
        res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false }); }
});

// Donation
app.post('/donate', async (req, res) => { /* Same logic as before */ 
    // ... (העתק את לוגיקת התרומה מהגרסה הקודמת)
    // רק שים לב: כאן אין שינוי לוגי, רק שימוש ב-PIN בצד לקוח
});

// --- ADMIN ---
const ADMIN_PASSWORD = "admin1234";

app.post('/admin/login', (req, res) => {
    if (req.body.password === ADMIN_PASSWORD) res.json({ success: true });
    else res.json({ success: false });
});

// ✅ דשבורד סטטיסטיקות
app.post('/admin/stats', async (req, res) => {
    if (req.body.password !== ADMIN_PASSWORD) return res.status(403).json({ success: false });
    try {
        const totalUsers = await User.countDocuments();
        const users = await User.find();
        
        let totalDonated = 0;
        let totalDonationsCount = 0;
        let monthlyDonated = 0;
        const now = new Date();
        const currentMonth = now.getMonth();
        const currentYear = now.getFullYear();

        users.forEach(u => {
            if (u.donationsHistory) {
                u.donationsHistory.forEach(d => {
                    if (d.status === 'success') {
                        totalDonated += (d.amount || 0);
                        totalDonationsCount++;
                        const dDate = new Date(d.date);
                        if (dDate.getMonth() === currentMonth && dDate.getFullYear() === currentYear) {
                            monthlyDonated += (d.amount || 0);
                        }
                    }
                });
            }
        });

        res.json({ success: true, stats: { totalUsers, totalDonated, totalDonationsCount, monthlyDonated } });
    } catch (e) { res.status(500).json({ success: false }); }
});

// ✅ שליפת כל המשתמשים (או חיפוש)
app.post('/admin/get-users', async (req, res) => {
    const { password, searchQuery } = req.body;
    if (password !== ADMIN_PASSWORD) return res.status(403).json({ success: false });

    try {
        let query = {};
        if (searchQuery) {
            const regex = new RegExp(searchQuery, 'i');
            query.$or = [{ name: regex }, { email: regex }, { phone: regex }, { tz: regex }];
        }
        // מחזיר את כולם אם אין שאילתה
        const users = await User.find(query).sort({ totalDonated: -1 });
        res.json({ success: true, users });
    } catch (e) { res.status(500).json({ success: false }); }
});

// ✅ עדכון משתמש מלא (אדמין)
app.post('/admin/update-user-full', async (req, res) => {
    const { password, userId, userData } = req.body; // userData מכיל הכל
    if (password !== ADMIN_PASSWORD) return res.status(403).json({ success: false });
    try {
        await User.findByIdAndUpdate(userId, userData);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false }); }
});

app.post('/admin/delete-user', async (req, res) => {
    if (req.body.password !== ADMIN_PASSWORD) return res.status(403).json({ success: false });
    try { await User.findByIdAndDelete(req.body.userId); res.json({ success: true }); } catch (e) { res.status(500).json({ success: false }); }
});

// (השאר את שאר הפונקציות כמו push/delete-pending כרגיל)

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`✅ Server Live on Port ${PORT}`));
