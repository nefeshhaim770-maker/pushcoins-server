const express = require('express');
const cors = require('cors');
const axios = require('axios');
const mongoose = require('mongoose');
const cron = require('node-cron'); // ספרייה לתזמון משימות
const admin = require('firebase-admin'); // ספרייה להודעות פוש
const app = express();

app.use(express.json());
app.use(cors());

// --- הגדרת Firebase להודעות פוש ---
try {
    // השרת יחפש את הקובץ שהעלית ל-Secret Files ב-Render
    // הנתיב /etc/secrets/ הוא הנתיב הקבוע שבו Render שומר קבצים סודיים
    const serviceAccount = require('/etc/secrets/serviceAccountKey.json'); 
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
    });
    console.log("✅ Firebase Admin Initialized");
} catch (error) {
    // נסיון טעינה מקומי (למקרה של הרצה במחשב שלך)
    try {
        const serviceAccount = require('./serviceAccountKey.json');
        admin.initializeApp({
            credential: admin.credential.cert(serviceAccount)
        });
        console.log("✅ Firebase Admin Initialized (Local)");
    } catch (e) {
        console.log("⚠️ Warning: Firebase key not found. Push notifications won't work.");
    }
}

// --- חיבור ל-MongoDB ---
mongoose.connect('mongodb+srv://nefeshhaim770_db_user:DxNzxIrIaoji0gWm@cluster0.njggbyd.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0')
    .then(async () => {
        console.log('✅ MongoDB Connected');
        try { await mongoose.connection.db.collection('users').dropIndex('phone_1'); } catch (e) { }
        try { await mongoose.connection.db.collection('users').dropIndex('email_1'); } catch (e) { }
    })
    .catch(err => console.error('❌ MongoDB Error:', err));

// --- סכמה משודרגת ---
const userSchema = new mongoose.Schema({
    // פרטים אישיים
    email: { type: String, sparse: true, unique: true },
    phone: { type: String, sparse: true, unique: true },
    name: String,
    tz: String,
    
    // פרטי אשראי וטוקן
    lastExpiry: String,
    lastCardDigits: String,
    token: { type: String, default: "" },
    
    // הגדרות חיוב ותרומות
    totalDonated: { type: Number, default: 0 },
    
    // 0 = חיוב מיידי, 2 = ב-2 לחודש, 10 = ב-10 לחודש
    billingPreference: { type: Number, default: 0 }, 
    
    // סכום לחיוב יומי קבוע (0 = לא פעיל)
    recurringDailyAmount: { type: Number, default: 0 },
    
    // טוקן למכשיר הטלפון (עבור הודעות פוש)
    fcmToken: { type: String, default: "" },

    // היסטוריית תרומות שבוצעו
    donationsHistory: [{
        amount: Number,
        date: { type: Date, default: Date.now },
        note: String,
        status: { type: String, default: 'success' }, 
        failReason: String,
        cardDigits: String,
        transactionId: String // מספר אסמכתא מקשר
    }],

    // תרומות שממתינות לחיוב המרוכז (סל תרומות)
    pendingDonations: [{
        _id: { type: mongoose.Schema.Types.ObjectId, auto: true }, // מזהה ייחודי למחיקה
        amount: Number,
        date: { type: Date, default: Date.now },
        note: String
    }],
    
    tempCode: String
});
const User = mongoose.model('User', userSchema);

// --- פונקציות עזר ---

function sortObjectKeys(obj) {
    return Object.keys(obj).sort().reduce((result, key) => {
        result[key] = obj[key];
        return result;
    }, {});
}

function fixToken(token) {
    if (!token) return "";
    let strToken = String(token).replace(/['"]+/g, '').trim();
    if (strToken.length > 0 && !strToken.startsWith('0')) {
        return '0' + strToken;
    }
    return strToken;
}

// פונקציה מרכזית לחיוב מול "קשר"
async function chargeKesher(user, amount, note, creditDetails = null) {
    const amountInAgorot = Math.round(parseFloat(amount) * 100);
    const realIdToSend = user.tz || "000000000";
    const safePhone = (user.phone || "0500000000").replace(/\D/g, '');

    let tranData = {
        Total: amountInAgorot,
        Currency: 1, 
        CreditType: 1, 
        ParamJ: "J4", 
        TransactionType: "debit",
        ProjectNumber: "00001",
        Phone: safePhone,
        FirstName: (user.name || "Torem").split(" ")[0],
        LastName: (user.name || "").split(" ").slice(1).join(" ") || "Family",
        Mail: user.email || "no-email@test.com",
        ClientApiIdentity: realIdToSend, // זיהוי לקוח CRM
        Id: realIdToSend, 
        Details: note || ""
    };

    let finalExpiry = user.lastExpiry;
    let currentCardDigits = user.lastCardDigits;

    // שימוש בכרטיס חדש אם סופק, אחרת בטוקן
    if (creditDetails) {
        tranData.CreditNum = creditDetails.num;
        if (creditDetails.exp.length === 4) {
            finalExpiry = creditDetails.exp.substring(2, 4) + creditDetails.exp.substring(0, 2);
        } else {
            finalExpiry = creditDetails.exp;
        }
        tranData.Expiry = finalExpiry;
        currentCardDigits = creditDetails.num.slice(-4);
    } else if (user.token) {
        tranData.Token = fixToken(user.token);
        tranData.Expiry = user.lastExpiry;
    } else {
        throw new Error("חסר אמצעי תשלום (טוקן או כרטיס)");
    }

    const sortedTranData = sortObjectKeys(tranData);
    
    const response = await axios.post('https://kesherhk.info/ConnectToKesher/ConnectToKesher', {
        Json: { 
            userName: '2181420WS2087', 
            password: 'WVmO1iterNb33AbWLzMjJEyVnEQbskSZqyel5T61Hb5qdwR0gl', 
            func: "SendTransaction", 
            format: "json", 
            tran: sortedTranData 
        },
        format: "json"
    }, { validateStatus: () => true });

    const resData = response.data;
    const isSuccess = resData.RequestResult?.Status === true || resData.Status === true;
    
    return { isSuccess, resData, currentCardDigits, finalExpiry };
}

// --- משימות מתוזמנות (Cron Jobs) ---

// 1. הוראת קבע יומית + חיובים מיידיים - רץ כל יום ב-07:00 בבוקר
cron.schedule('0 7 * * *', async () => {
    console.log("⏰ Starting Daily Cron Job...");
    const users = await User.find({ recurringDailyAmount: { $gt: 0 } }); // רק מי שהגדיר סכום יומי

    for (const user of users) {
        // אם המשתמש מוגדר לחיוב מיידי (0) -> מחייבים מיד
        if (user.billingPreference === 0) {
            try {
                if (!user.token) continue; // אי אפשר לחייב ללא טוקן
                const result = await chargeKesher(user, user.recurringDailyAmount, "תרומה יומית קבועה");
                
                if (result.isSuccess) {
                    user.totalDonated += user.recurringDailyAmount;
                    user.donationsHistory.push({
                        amount: user.recurringDailyAmount,
                        note: "תרומה יומית קבועה",
                        date: new Date(),
                        status: 'success',
                        cardDigits: user.lastCardDigits
                    });
                } else {
                    user.donationsHistory.push({
                        amount: user.recurringDailyAmount,
                        note: "תרומה יומית קבועה - נכשל",
                        date: new Date(),
                        status: 'failed',
                        failReason: result.resData.Description || "שגיאה בחיוב יומי"
                    });
                }
                await user.save();
            } catch (e) { console.error(`Failed daily charge for user ${user._id}`, e); }
        } 
        // אם המשתמש מוגדר לחיוב מצטבר (2 או 10) -> מוסיפים לרשימת ההמתנה
        else {
            user.pendingDonations.push({
                amount: user.recurringDailyAmount,
                note: "תרומה יומית קבועה (ממתין לחיוב)",
                date: new Date()
            });
            await user.save();
        }
    }
    console.log("✅ Daily Cron Job Finished");
});

// 2. חיוב מרוכז - רץ ב-2 וב-10 לחודש ב-09:00 בבוקר
cron.schedule('0 9 2,10 * *', async () => {
    const today = new Date().getDate(); // 2 או 10
    console.log(`⏰ Starting Monthly Aggregated Billing for day ${today}...`);
    
    // מוצאים את כל המשתמשים שבחרו בתאריך הזה ויש להם תרומות בהמתנה
    const users = await User.find({ 
        billingPreference: today, 
        pendingDonations: { $exists: true, $not: { $size: 0 } } 
    });

    for (const user of users) {
        let totalAmount = 0;
        user.pendingDonations.forEach(d => totalAmount += d.amount);

        if (totalAmount > 0) {
            try {
                const result = await chargeKesher(user, totalAmount, `חיוב מרוכז לחודש (עבור ${user.pendingDonations.length} תרומות)`);
                
                if (result.isSuccess) {
                    user.totalDonated += totalAmount;
                    // שומרים בהיסטוריה
                    user.donationsHistory.push({
                        amount: totalAmount,
                        note: "חיוב מרוכז חודשי",
                        date: new Date(),
                        status: 'success',
                        cardDigits: user.lastCardDigits
                    });
                    // מנקים את רשימת ההמתנה
                    user.pendingDonations = [];
                } else {
                     user.donationsHistory.push({
                        amount: totalAmount,
                        note: "חיוב מרוכז נכשל",
                        date: new Date(),
                        status: 'failed',
                        failReason: result.resData.Description
                    });
                }
                await user.save();
            } catch (e) { console.error(`Failed monthly charge for user ${user._id}`, e); }
        }
    }
    console.log("✅ Monthly Billing Finished");
});


// --- Routes ---

// שמירת טוקן לפוש (מהאפליקציה)
app.post('/save-push-token', async (req, res) => {
    const { userId, token } = req.body;
    try {
        await User.findByIdAndUpdate(userId, { fcmToken: token });
        res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false }); }
});

// עדכון הגדרות משתמש (יום חיוב + סכום יומי)
app.post('/update-settings', async (req, res) => {
    const { userId, billingPreference, recurringDailyAmount } = req.body;
    try {
        await User.findByIdAndUpdate(userId, { 
            billingPreference: parseInt(billingPreference), // 0, 2, or 10
            recurringDailyAmount: parseFloat(recurringDailyAmount) || 0
        });
        res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false }); }
});

// קבלת רשימת תרומות ממתינות (כדי שהמשתמש יוכל למחוק)
app.post('/get-pending-donations', async (req, res) => {
    const { userId } = req.body;
    try {
        const user = await User.findById(userId);
        res.json({ success: true, pending: user.pendingDonations, billingDay: user.billingPreference });
    } catch (e) { res.status(500).json({ success: false }); }
});

// מחיקת תרומה ממתינה
app.post('/delete-pending', async (req, res) => {
    const { userId, donationId } = req.body;
    try {
        await User.findByIdAndUpdate(userId, {
            $pull: { pendingDonations: { _id: donationId } }
        });
        res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false }); }
});

// מסלול התרומה הראשי (מעודכן)
app.post('/donate', async (req, res) => {
    const { userId, amount, ccDetails, fullName, tz, useToken, phone, email, note, forceImmediate } = req.body;

    try {
        let user = await User.findById(userId);
        if (!user) return res.status(404).json({ success: false, error: "משתמש לא נמצא" });

        // עדכון פרטים אם נשלחו
        if (fullName) user.name = fullName;
        if (tz) user.tz = tz;
        if (phone) user.phone = phone;
        if (email) user.email = email;

        // בדיקה: האם זה חיוב מיידי?
        // כן אם: המשתמש בחר תשלום מיידי (0) OR לחץ על "תרומה ישירה" (forceImmediate) OR אין לו טוקן שמור ומשלם באשראי עכשיו
        const shouldChargeNow = user.billingPreference === 0 || forceImmediate === true || (!useToken && ccDetails);

        if (shouldChargeNow) {
            console.log("🚀 מבצע חיוב מיידי...");
            
            // שימוש בפונקציית העזר לחיוב
            const result = await chargeKesher(user, amount, note, !useToken ? ccDetails : null);

            if (result.isSuccess) {
                // עדכון טוקן אם הגיע חדש
                if (!useToken && result.resData.Token) {
                    user.token = fixToken(result.resData.Token);
                    user.lastCardDigits = result.currentCardDigits;
                    user.lastExpiry = result.finalExpiry;
                }

                user.totalDonated += parseFloat(amount);
                user.donationsHistory.push({ 
                    amount: parseFloat(amount), 
                    note: note || "", 
                    date: new Date(),
                    status: 'success',
                    cardDigits: user.lastCardDigits || result.currentCardDigits
                });
                
                await user.save();
                res.json({ success: true, user, message: "התרומה בוצעה בהצלחה!" });
            } else {
                const errorMsg = result.resData.RequestResult?.Description || result.resData.Description || "סירוב עסקה";
                if (errorMsg.includes("טוקן")) user.token = "";
                
                user.donationsHistory.push({ 
                    amount: parseFloat(amount), 
                    note: note || "", 
                    date: new Date(),
                    status: 'failed',
                    failReason: errorMsg,
                    cardDigits: user.lastCardDigits
                });
                await user.save();
                res.status(400).json({ success: false, error: errorMsg });
            }

        } else {
            // הוספה לרשימת ההמתנה (מצטבר)
            console.log("⏳ מוסיף לרשימת ההמתנה לחיוב מרוכז...");
            user.pendingDonations.push({
                amount: parseFloat(amount),
                note: note || "",
                date: new Date()
            });
            await user.save();
            res.json({ success: true, user, message: `התרומה נוספה לסל ותחויב ב-${user.billingPreference} לחודש` });
        }

    } catch (e) {
        console.error("🔥 Error:", e.message);
        res.status(500).json({ success: false, error: "שגיאת תקשורת: " + e.message });
    }
});

// --- ADMIN & LOGINS ---
app.post('/update-code', async (req, res) => {
    let { email, phone, code } = req.body;
    try {
        let cleanEmail = undefined;
        let cleanPhone = undefined;

        if (email && email.toString().trim() !== "") cleanEmail = email.toString().toLowerCase().trim();
        if (!cleanEmail && phone && phone.toString().trim() !== "") cleanPhone = phone.toString().replace(/\D/g, '').trim();

        if (!cleanEmail && !cleanPhone) return res.status(400).json({ success: false, error: "חובה להזין מייל או טלפון" });

        const query = cleanEmail ? { email: cleanEmail } : { phone: cleanPhone };
        let updateData = { tempCode: code };
        if (cleanEmail) updateData.email = cleanEmail;
        if (cleanPhone) updateData.phone = cleanPhone;
        await User.findOneAndUpdate(query, { $set: updateData }, { upsert: true, new: true });

        // EmailJS
        if (cleanEmail) {
            try {
                const PRIVATE_KEY = "b-Dz-J0Iq_yJvCfqX5Iw3"; 
                await axios.post('https://api.emailjs.com/api/v1.0/email/send', {
                    service_id: 'service_8f6h188',
                    template_id: 'template_tzbq0k4',
                    user_id: 'yLYooSdg891aL7etD',
                    template_params: { email: cleanEmail, code: code },
                    accessToken: PRIVATE_KEY
                });
            } catch (emailError) {}
        }
        res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false }); }
});

app.post('/verify-auth', async (req, res) => {
    let { email, phone, code } = req.body;
    try {
        if (code === 'check') return res.json({ success: true });
        let cleanEmail = undefined; let cleanPhone = undefined;
        if (email) cleanEmail = email.toString().toLowerCase().trim();
        if (phone) cleanPhone = phone.toString().replace(/\D/g, '').trim();
        const query = cleanEmail ? { email: cleanEmail } : { phone: cleanPhone };
        if (Object.keys(query).length === 0) return res.json({ success: false, error: "חסר פרטים" });
        let user = await User.findOne(query);
        if (user && String(user.tempCode).trim() === String(code).trim()) {
            res.json({ success: true, user });
        } else {
            res.json({ success: false, error: "קוד שגוי" });
        }
    } catch (e) { res.status(500).json({ success: false }); }
});

app.post('/login-by-id', async (req, res) => {
    const { userId } = req.body;
    try {
        let user = await User.findById(userId);
        if (user) res.json({ success: true, user });
        else res.json({ success: false });
    } catch (e) { res.status(500).json({ success: false }); }
});

// --- ADMIN SECTION ---
const ADMIN_PASSWORD = "admin1234";

app.post('/admin/login', (req, res) => {
    const { password } = req.body;
    if (password === ADMIN_PASSWORD) res.json({ success: true });
    else res.json({ success: false, error: "סיסמה שגויה" });
});

// חיפוש מתקדם לאדמין
app.post('/admin/search-users', async (req, res) => {
    const { password, searchQuery, startDate, endDate } = req.body;
    if (password !== ADMIN_PASSWORD) return res.status(403).json({ success: false });

    try {
        let query = {};

        // חיפוש לפי טקסט (שם, מייל, טלפון, ת"ז)
        if (searchQuery) {
            const regex = new RegExp(searchQuery, 'i');
            query.$or = [
                { name: regex },
                { email: regex },
                { phone: regex },
                { tz: regex }
            ];
        }

        let users = await User.find(query).sort({ totalDonated: -1 });

        // סינון תרומות לפי תאריכים
        if (startDate && endDate) {
            const start = new Date(startDate);
            const end = new Date(endDate);
            end.setHours(23, 59, 59);

            users = users.map(user => {
                const filteredHistory = user.donationsHistory.filter(d => {
                    const dDate = new Date(d.date);
                    return dDate >= start && dDate <= end;
                });
                let userObj = user.toObject();
                userObj.donationsHistory = filteredHistory;
                return userObj;
            });
        }

        res.json({ success: true, users });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// שליחת הודעת פוש לכולם
app.post('/admin/send-push', async (req, res) => {
    const { password, title, body } = req.body;
    if (password !== ADMIN_PASSWORD) return res.status(403).json({ success: false });

    try {
        // משיכת כל הטוקנים מהמסד
        const users = await User.find({ fcmToken: { $exists: true, $ne: "" } });
        const tokens = users.map(u => u.fcmToken);

        if (tokens.length === 0) return res.json({ success: false, error: "אין משתמשים רשומים לפוש" });

        // שליחה בקבוצות (Firebase תומך עד 500 במכה)
        const message = {
            notification: { title, body },
            tokens: tokens
        };

        const response = await admin.messaging().sendMulticast(message);
        console.log(response.successCount + ' messages were sent successfully');
        
        res.json({ success: true, sentCount: response.successCount, failCount: response.failureCount });

    } catch (e) { 
        console.error("Push Error:", e);
        res.status(500).json({ success: false, error: "שגיאה בשליחת הודעות" }); 
    }
});

app.post('/admin/delete-user', async (req, res) => {
    const { password, userId } = req.body;
    if (password !== ADMIN_PASSWORD) return res.status(403).json({ success: false });
    try { await User.findByIdAndDelete(userId); res.json({ success: true }); } catch (e) { res.status(500).json({ success: false }); }
});

app.post('/admin/update-user', async (req, res) => {
    const { password, userId, name, email, phone, tz, token } = req.body;
    if (password !== ADMIN_PASSWORD) return res.status(403).json({ success: false });
    try {
        let updateData = { name, tz, token };
        if (email) updateData.email = email;
        if (phone) updateData.phone = phone;
        await User.findByIdAndUpdate(userId, updateData);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false }); }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`✅ Server Live`));
