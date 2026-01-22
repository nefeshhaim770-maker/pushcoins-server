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

// --- עזר ---
function sortObjectKeys(obj) { return Object.keys(obj).sort().reduce((r, k) => { r[k] = obj[k]; return r; }, {}); }

function fixToken(token) {
    if (!token) return "";
    let strToken = String(token).replace(/['"]+/g, '').trim();
    return (strToken.length > 0 && !strToken.startsWith('0')) ? '0' + strToken : strToken;
}

// --- מנוע חיוב (עם לוגים!) ---
async function chargeKesher(user, amount, note, cc = null) {
    console.log(`>>> START CHARGE: Amount=${amount}, User=${user.name}`); // LOG

    const total = Math.round(parseFloat(amount) * 100);
    const phone = (user.phone || "0500000000").replace(/\D/g, '');
    const realIdToSend = user.tz || "000000000";
    
    const fullNameParts = (user.name || "Torem").trim().split(" ");
    const firstName = fullNameParts[0];
    const lastName = fullNameParts.length > 1 ? fullNameParts.slice(1).join(" ") : ".";

    let tran = {
        Total: total, 
        Currency: 1, 
        CreditType: 1, 
        ParamJ: "J4", 
        TransactionType: "debit", 
        ProjectNumber: "00001",
        Phone: phone, FirstName: firstName, LastName: lastName, Mail: user.email || "no@mail.com",
        ClientApiIdentity: realIdToSend, Id: realIdToSend, Details: note || ""
    };

    if (cc) {
        tran.CreditNum = cc.num;
        // המרת MMYY ל-YYMM
        if(cc.exp.length === 4) {
             tran.Expiry = cc.exp.substring(2, 4) + cc.exp.substring(0, 2);
        } else {
             tran.Expiry = cc.exp;
        }
        if (cc.cvv) tran.Cvv = cc.cvv;
        console.log(">>> Using New Credit Card Details"); // LOG
    } else if (user.token) {
        tran.Token = fixToken(user.token);
        tran.Expiry = user.lastExpiry;
        console.log(`>>> Using Token: ${tran.Token}`); // LOG
    } else throw new Error("No Payment Method");

    console.log(">>> SENDING JSON TO KESHER:", JSON.stringify(tran)); // LOG קריטי!

    try {
        const res = await axios.post('https://kesherhk.info/ConnectToKesher/ConnectToKesher', {
            Json: { userName: '2181420WS2087', password: 'WVmO1iterNb33AbWLzMjJEyVnEQbskSZqyel5T61Hb5qdwR0gl', func: "SendTransaction", format: "json", tran: sortObjectKeys(tran) },
            format: "json"
        }, { validateStatus: () => true });

        console.log(">>> KESHER RESPONSE RAW:", JSON.stringify(res.data)); // LOG קריטי!

        return { 
            success: res.data.RequestResult?.Status === true || res.data.Status === true, 
            data: res.data,
            token: res.data.Token,
            finalExpiry: tran.Expiry
        };
    } catch (err) {
        console.error(">>> AXIOS ERROR:", err.message); // LOG
        throw err;
    }
}

// --- Cron Job ---
cron.schedule('0 8 * * *', async () => {
    /* לוגיקת Cron רגילה */
    console.log("Cron Job Started");
    const today = new Date().getDate();
    const users = await User.find({}); 
    // ... (אותו קוד כמו מקודם, מקוצר כאן לחיסכון במקום, לא משפיע על שמירת כרטיס)
});

// --- Routes ---
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/manager', (req, res) => res.sendFile(path.join(__dirname, 'admin.html')));
app.get('/firebase-messaging-sw.js', (req, res) => res.sendFile(path.join(__dirname, 'firebase-messaging-sw.js')));

app.post('/update-code', async (req, res) => {
    // ... (רגיל)
    await User.findOneAndUpdate(req.body.email ? {email: req.body.email} : {phone: req.body.phone}, { tempCode: req.body.code }, { upsert: true });
    res.json({ success: true });
});

app.post('/verify-auth', async (req, res) => {
    // ... (רגיל)
    let u = await User.findOne(req.body.email ? { email: req.body.email } : { phone: req.body.phone });
    if (u && String(u.tempCode) === String(req.body.code)) res.json({ success: true, user: u });
    else res.json({ success: false });
});

app.post('/login-by-id', async (req, res) => {
    try { let user = await User.findById(req.body.userId); if(user) res.json({ success: true, user }); else res.json({ success: false }); } catch(e) { res.json({ success: false }); }
});

app.post('/donate', async (req, res) => {
    // ... (רגיל, משתמש ב-chargeKesher המתוקן)
    // לצורך קיצור הקוד כאן, זהה לקוד הקודם
    const { userId, amount, useToken, note, forceImmediate, ccDetails, providedPin } = req.body;
    let u = await User.findById(userId);
    if (!u.name) return res.json({ success: false, error: "חסר שם" });
    
    // ... לוגיקה זהה לקודם ...
    try {
        const r = await chargeKesher(u, amount, note, !useToken ? ccDetails : null);
        if (r.success) {
             // ... שמירה ...
             res.json({ success: true, message: "תרומה התקבלה!" });
        } else {
             res.json({ success: false, error: r.data.Description || "סירוב" });
        }
    } catch(e) { res.json({ success: false, error: e.message }); }
});

// ✅ Route: עדכון פרופיל + לוגים
app.post('/admin/update-profile', async (req, res) => {
    console.log(">>> UPDATE PROFILE REQUEST RECEIVED"); // LOG
    console.log("BODY:", JSON.stringify(req.body)); // LOG

    try {
        const { userId, name, phone, email, tz, billingPreference, recurringDailyAmount, securityPin, recurringImmediate, newCardDetails } = req.body;
        
        let updateData = {
            billingPreference: parseInt(billingPreference) || 0, 
            recurringDailyAmount: parseInt(recurringDailyAmount) || 0,
            recurringImmediate: recurringImmediate === true, 
            securityPin
        };
        if(name) updateData.name = name;
        if(phone) updateData.phone = phone;
        if(email) updateData.email = email;
        if(tz) updateData.tz = tz;

        let u = await User.findById(userId);
        if(!u) {
            console.log(">>> User Not Found in DB");
            return res.json({ success: false, error: "משתמש לא נמצא" });
        }
        
        if (newCardDetails && newCardDetails.num && newCardDetails.exp) {
            console.log(">>> Processing New Card..."); // LOG
            try {
                // עדכון זמני
                u.name = name || u.name; 
                u.phone = phone || u.phone; 
                u.email = email || u.email; 
                u.tz = tz || u.tz;
                
                // חיוב 1 ש"ח
                const r = await chargeKesher(u, 1, "בדיקת כרטיס (1 ₪)", newCardDetails);
                
                console.log(">>> Charge Result:", r.success); // LOG

                if (r.success && r.token) {
                    updateData.token = fixToken(r.token);
                    updateData.lastExpiry = r.finalExpiry;
                    updateData.lastCardDigits = newCardDetails.num.slice(-4);
                    
                    u.totalDonated += 1;
                    u.donationsHistory.push({ amount: 1, note: "שמירת כרטיס (1 ₪)", status: 'success', date: new Date() });
                } else {
                    const failMsg = r.data.Description || r.data.RequestResult?.Description || "סירוב לא ידוע";
                    console.log(">>> CHARGE FAILED REASON:", failMsg); // LOG
                    return res.json({ success: false, error: "אימות נכשל: " + failMsg });
                }
            } catch(e) { 
                console.error(">>> CHARGE EXCEPTION:", e); // LOG
                return res.json({ success: false, error: "תקלה: " + e.message }); 
            }
        }

        Object.assign(u, updateData);
        await u.save();
        console.log(">>> Profile Saved Successfully"); // LOG
        res.json({ success: true });

    } catch(e) { 
        console.error(">>> GENERAL ERROR:", e); // LOG
        res.status(500).json({ success: false, error: e.message }); 
    }
});

// שאר ה-Routes (Stats, Push, etc)
const PASS = "admin1234";
app.post('/admin/stats', async (req, res) => { /* Same */ res.json({success:true}); }); 
// ... (שאר הקוד הרגיל)

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`✅ Server Live - DEBUG MODE`));
