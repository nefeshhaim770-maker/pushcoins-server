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

// --- Helpers ---
function sortObjectKeys(obj) { return Object.keys(obj).sort().reduce((r, k) => { r[k] = obj[k]; return r; }, {}); }

function fixToken(token) {
    if (!token) return "";
    let strToken = String(token).replace(/['"]+/g, '').trim();
    // מוודא שיש 0 בהתחלה (קריטי לקשר)
    return (strToken.length > 0 && !strToken.startsWith('0')) ? '0' + strToken : strToken;
}

// --- מנוע חיוב (לוגיקה: J4, 1₪, הפיכת תאריך, ללא CVV) ---
async function chargeKesher(user, amount, note, creditDetails = null) {
    const amountInAgorot = Math.round(parseFloat(amount) * 100);
    const safePhone = (user.phone || "0500000000").replace(/\D/g, '');
    const realIdToSend = user.tz || "000000000"; 

    const firstName = (user.name || "Torem").split(" ")[0];
    const lastName = (user.name || "").split(" ").slice(1).join(" ") || ".";

    let tranData = {
        Total: amountInAgorot,
        Currency: 1, 
        CreditType: 1, 
        ParamJ: "J4", 
        TransactionType: "debit", 
        ProjectNumber: "00001",
        Phone: safePhone, 
        FirstName: firstName, 
        LastName: lastName, 
        Mail: user.email || "no@mail.com",
        ClientApiIdentity: realIdToSend, 
        Id: realIdToSend,                
        Details: note || ""
    };

    let finalExpiry = user.lastExpiry;
    let currentCardDigits = user.lastCardDigits;

    if (creditDetails) {
        tranData.CreditNum = creditDetails.num;
        
        // ✅ הפיכת תאריך מ-MMYY (לקוח) ל-YYMM (קשר)
        if (creditDetails.exp.length === 4) {
            finalExpiry = creditDetails.exp.substring(2, 4) + creditDetails.exp.substring(0, 2);
        } else {
            finalExpiry = creditDetails.exp;
        }
        tranData.Expiry = finalExpiry;
        currentCardDigits = creditDetails.num.slice(-4);
        
        // CVV לא נשלח כי הוא גורם לשגיאת סכמה בשרת זה

    } else if (user.token) {
        tranData.Token = fixToken(user.token);
        tranData.Expiry = user.lastExpiry; 
    } else { 
        throw new Error("No Payment Method"); 
    }

    const res = await axios.post('https://kesherhk.info/ConnectToKesher/ConnectToKesher', {
        Json: { userName: '2181420WS2087', password: 'WVmO1iterNb33AbWLzMjJEyVnEQbskSZqyel5T61Hb5qdwR0gl', func: "SendTransaction", format: "json", tran: sortObjectKeys(tranData) },
        format: "json"
    }, { validateStatus: () => true });

    return { 
        success: res.data.RequestResult?.Status === true || res.data.Status === true, 
        data: res.data, 
        token: res.data.Token, 
        finalExpiry, 
        currentCardDigits 
    };
}

// --- Cron Job ---
cron.schedule('0 8 * * *', async () => {
    const today = new Date().getDate();
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
        if (u.billingPreference === today && u.pendingDonations.length > 0) {
            let totalToCharge = 0;
            u.pendingDonations.forEach(d => totalToCharge += d.amount);
            if (totalToCharge > 0 && u.token) {
                try {
                    await chargeKesher(u, totalToCharge, "חיוב סל חודשי מרוכז");
                    u.totalDonated += totalToCharge;
                    u.pendingDonations.forEach(d => { u.donationsHistory.push({ amount: d.amount, note: d.note, status: "success", date: new Date() }); });
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

// ✅✅✅ התיקון: שחזור שליחת האימייל! ✅✅✅
app.post('/update-code', async (req, res) => {
    let { email, phone, code } = req.body;
    let cleanEmail = email ? email.toLowerCase().trim() : undefined;
    let cleanPhone = phone ? phone.replace(/\D/g, '').trim() : undefined;
    
    // קוד שליחת המייל שחסר
    if (cleanEmail) {
        try { 
            await axios.post('https://api.emailjs.com/api/v1.0/email/send', { 
                service_id: 'service_8f6h188', 
                template_id: 'template_tzbq0k4', 
                user_id: 'yLYooSdg891aL7etD', 
                template_params: { email: cleanEmail, code: code }, 
                accessToken: "b-Dz-J0Iq_yJvCfqX5Iw3" 
            }); 
        } catch (e) { console.log("Email Error", e.message); }
    }

    await User.findOneAndUpdate(
        cleanEmail ? { email: cleanEmail } : { phone: cleanPhone }, 
        { tempCode: code, email: cleanEmail, phone: cleanPhone }, 
        { upsert: true }
    );
    res.json({ success: true });
});

app.post('/verify-auth', async (req, res) => {
    let { email, phone, code } = req.body;
    if(code === 'check') return res.json({ success: true });
    
    let cleanEmail = email ? email.toLowerCase().trim() : undefined;
    let cleanPhone = phone ? phone.replace(/\D/g, '').trim() : undefined;

    let u = await User.findOne(cleanEmail ? { email: cleanEmail } : { phone: cleanPhone });
    if (u && String(u.tempCode).trim() === String(code).trim()) res.json({ success: true, user: u });
    else res.json({ success: false });
});

app.post('/login-by-id', async (req, res) => {
    try { let user = await User.findById(req.body.userId); if(user) res.json({ success: true, user }); else res.json({ success: false }); } catch(e) { res.json({ success: false }); }
});

app.post('/donate', async (req, res) => {
    const { userId, amount, useToken, note, forceImmediate, ccDetails, providedPin } = req.body;
    let u = await User.findById(userId);
    
    // בדיקות גמישות
    if (u.securityPin && u.securityPin.trim() !== "") {
        if (String(providedPin).trim() !== String(u.securityPin).trim()) return res.json({ success: false, error: "קוד אבטחה (PIN) שגוי" });
    }

    let shouldChargeNow = (forceImmediate === true) ? true : (u.billingPreference === 0 && forceImmediate !== false);

    if (shouldChargeNow) {
        try {
            const r = await chargeKesher(u, amount, note, !useToken ? ccDetails : null);
            if (r.success) {
                if(r.token) { 
                    u.token = fixToken(r.token); 
                    u.lastExpiry = r.finalExpiry; 
                    if(r.currentCardDigits) u.lastCardDigits = r.currentCardDigits; 
                }
                u.totalDonated += parseFloat(amount);
                u.donationsHistory.push({ amount: parseFloat(amount), note, date: new Date(), status: 'success' });
                await u.save();
                res.json({ success: true, message: "תרומה התקבלה!" });
            } else {
                let err = r.data.Description || r.data.RequestResult?.Description || "סירוב";
                res.json({ success: false, error: err });
            }
        } catch(e) { res.json({ success: false, error: e.message }); }
    } else {
        u.pendingDonations.push({ amount: parseFloat(amount), note, date: new Date() });
        await u.save();
        res.json({ success: true, message: "נוסף לסל" });
    }
});

// ✅ עדכון פרופיל + חיוב 1 ₪
app.post('/admin/update-profile', async (req, res) => {
    try {
        const { userId, name, phone, email, tz, billingPreference, recurringDailyAmount, securityPin, recurringImmediate, newCardDetails } = req.body;
        
        let updateData = { billingPreference: parseInt(billingPreference)||0, recurringDailyAmount: parseInt(recurringDailyAmount)||0, recurringImmediate: recurringImmediate===true, securityPin };
        if(name) updateData.name = name; if(phone) updateData.phone = phone; if(email) updateData.email = email; if(tz) updateData.tz = tz;

        let u = await User.findById(userId);
        
        if (newCardDetails && newCardDetails.num && newCardDetails.exp) {
            try {
                u.name = name || u.name; u.phone = phone || u.phone; u.email = email || u.email; u.tz = tz || u.tz;
                
                // חיוב 1 ₪ (J4, MMYY -> YYMM)
                const r = await chargeKesher(u, 1, "בדיקת כרטיס (1 ₪)", newCardDetails);
                
                if (r.success && r.token) {
                    updateData.token = fixToken(r.token);
                    updateData.lastExpiry = r.finalExpiry;
                    updateData.lastCardDigits = r.currentCardDigits;
                    
                    u.totalDonated += 1;
                    u.donationsHistory.push({ amount: 1, note: "שמירת כרטיס (1 ₪)", status: 'success', date: new Date() });
                } else {
                    let err = r.data.Description || r.data.RequestResult?.Description || "סירוב";
                    return res.json({ success: false, error: "אימות נכשל: " + err });
                }
            } catch(e) { return res.json({ success: false, error: "תקלה: " + e.message }); }
        }

        Object.assign(u, updateData);
        await u.save();
        res.json({ success: true });

    } catch(e) { res.status(500).json({ success: false, error: e.message }); }
});

// שאר ה-Routes
const PASS = "admin1234";
app.post('/admin/stats', async (req, res) => { if(req.body.password !== PASS) return res.json({ success: false }); const users = await User.find(); let total = 0, count = 0; users.forEach(u => u.donationsHistory?.forEach(d => { if(d.status==='success') { total += d.amount||0; count++; } })); res.json({ success: true, stats: { totalDonated: total, totalUsers: users.length, totalDonations: count } }); });
app.post('/admin/get-users', async (req, res) => { if(req.body.password !== PASS) return res.json({ success: false }); const users = await User.find().sort({ _id: -1 }); res.json({ success: true, users }); });
app.post('/admin/update-user-full', async (req, res) => { if(req.body.password !== PASS) return res.json({ success: false }); await User.findByIdAndUpdate(req.body.userId, req.body.userData); res.json({ success: true }); });
app.post('/admin/delete-user', async (req, res) => { if(req.body.password !== PASS) return res.json({ success: false }); await User.findByIdAndDelete(req.body.userId); res.json({ success: true }); });
app.post('/admin/recalc-totals', async (req, res) => { if(req.body.password !== PASS) return res.json({ success: false }); const users = await User.find(); let c=0; for (const u of users) { let t=0; if(u.donationsHistory) u.donationsHistory.forEach(d => { if(d.status==='success') t += d.amount||0; }); if(u.totalDonated!==t) { u.totalDonated=t; await u.save(); c++; } } res.json({ success: true, count: c }); });
app.post('/admin/send-push', async (req, res) => { if(req.body.password !== PASS) return res.json({ success: false }); const users = await User.find({ fcmToken: { $exists: true, $ne: "" } }); const tokens = users.map(u => u.fcmToken); if(tokens.length) { const response = await admin.messaging().sendMulticast({ notification: { title: req.body.title, body: req.body.body }, tokens }); res.json({ success: true, sentCount: response.successCount }); } else res.json({ success: false, error: "אין מכשירים" }); });
app.post('/save-push-token', async (req, res) => { await User.findByIdAndUpdate(req.body.userId, { fcmToken: req.body.token }); res.json({ success: true }); });
app.post('/delete-pending', async (req, res) => { await User.findByIdAndUpdate(req.body.userId, { $pull: { pendingDonations: { _id: req.body.donationId } } }); res.json({ success: true }); });
app.post('/reset-token', async (req, res) => { await User.findByIdAndUpdate(req.body.userId, { token: "", lastCardDigits: "" }); res.json({ success: true }); });

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`✅ Server Live`));
