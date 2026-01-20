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
    
    // 0 = מיידי, 1-28 = יום בחודש
    billingPreference: { type: Number, default: 0 }, 
    
    // סכום לחיוב יומי קבוע
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

    const resData = response.data;
    const isSuccess = resData.RequestResult?.Status === true || resData.Status === true;
    return { isSuccess, resData, currentCardDigits, finalExpiry };
}

// --- Cron Jobs (מערכת תזמון) ---

// 1. הוראת קבע יומית - רצה כל בוקר ב-07:00
cron.schedule('0 7 * * *', async () => {
    console.log("⏰ Starting Daily Recurring Donations...");
    const users = await User.find({ recurringDailyAmount: { $gt: 0 } });

    for (const user of users) {
        // אם מוגדר "חיוב מיידי" (0) - מחייב ישר. אחרת - מוסיף לסל.
        if (user.billingPreference === 0) {
            try {
                if (!user.token) continue;
                const result = await chargeKesher(user, user.recurringDailyAmount, "תרומה יומית קבועה");
                const status = result.isSuccess ? 'success' : 'failed';
                user.donationsHistory.push({
                    amount: user.recurringDailyAmount, note: "תרומה יומית קבועה", date: new Date(),
                    status: status, failReason: result.isSuccess ? '' : result.resData.Description, cardDigits: user.lastCardDigits
                });
                if(result.isSuccess) user.totalDonated += user.recurringDailyAmount;
                await user.save();
            } catch (e) { console.error(`Daily charge failed: ${user._id}`); }
        } else {
            user.pendingDonations.push({
                amount: user.recurringDailyAmount, note: "תרומה יומית קבועה (ממתין)", date: new Date()
            });
            await user.save();
        }
    }
});

// 2. חיוב מרוכז לפי תאריך בחירה - רץ כל יום ב-09:00
cron.schedule('0 9 * * *', async () => {
    const today = new Date().getDate(); // מחזיר את היום בחודש (למשל 15)
    console.log(`⏰ Checking billing for day: ${today}`);
    
    // מוצא משתמשים שהיום הוא יום החיוב שלהם
    const users = await User.find({ 
        billingPreference: today, 
        pendingDonations: { $exists: true, $not: { $size: 0 } } 
    });

    for (const user of users) {
        let totalAmount = 0;
        user.pendingDonations.forEach(d => totalAmount += d.amount);

        if (totalAmount > 0) {
            try {
                const result = await chargeKesher(user, totalAmount, `חיוב מרוכז (${user.pendingDonations.length} תרומות)`);
                if (result.isSuccess) {
                    user.totalDonated += totalAmount;
                    user.donationsHistory.push({
                        amount: totalAmount, note: "חיוב מרוכז חודשי", date: new Date(),
                        status: 'success', cardDigits: user.lastCardDigits
                    });
                    user.pendingDonations = [];
                } else {
                     user.donationsHistory.push({
                        amount: totalAmount, note: "חיוב מרוכז נכשל", date: new Date(),
                        status: 'failed', failReason: result.resData.Description
                    });
                }
                await user.save();
            } catch (e) { console.error(`Monthly charge failed: ${user._id}`); }
        }
    }
});

// --- API Routes ---
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/manager', (req, res) => res.sendFile(path.join(__dirname, 'admin.html')));

app.post('/update-code', async (req, res) => {
    let { email, phone, code } = req.body;
    try {
        let cleanEmail = email ? email.toLowerCase().trim() : undefined;
        let cleanPhone = phone ? phone.replace(/\D/g, '').trim() : undefined;
        const query = cleanEmail ? { email: cleanEmail } : { phone: cleanPhone };
        
        console.log(`🔑 LOGIN CODE: ${code}`); // לוג לגיבוי
        
        // כאן הקוד של EmailJS (נשאר אותו דבר)
        
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

// עדכון פרופיל והגדרות
app.post('/update-profile', async (req, res) => {
    try {
        const { userId, ...updates } = req.body;
        // המרה למספרים היכן שצריך
        if(updates.billingPreference) updates.billingPreference = parseInt(updates.billingPreference);
        if(updates.recurringDailyAmount) updates.recurringDailyAmount = parseFloat(updates.recurringDailyAmount);
        
        const user = await User.findByIdAndUpdate(userId, updates, { new: true });
        res.json({ success: true, user });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.post('/reset-token', async (req, res) => {
    try {
        await User.findByIdAndUpdate(req.body.userId, { token: "", lastCardDigits: "", lastExpiry: "" });
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
                user.donationsHistory.push({ amount: parseFloat(amount), note, date: new Date(), status: 'success', cardDigits: user.lastCardDigits || result.currentCardDigits });
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

app.post('/delete-pending', async (req, res) => {
    try {
        await User.findByIdAndUpdate(req.body.userId, { $pull: { pendingDonations: { _id: req.body.donationId } } });
        res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false }); }
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
        if (tokens.length === 0) return res.json({ success: false, error: "לא נמצאו מכשירים רשומים" });

        const response = await admin.messaging().sendMulticast({
            notification: { title: req.body.title, body: req.body.body },
            tokens: tokens
        });
        res.json({ success: true, sentCount: response.successCount });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`✅ Server Live`));
