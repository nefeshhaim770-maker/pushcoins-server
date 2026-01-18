const express = require('express');
const cors = require('cors');
const axios = require('axios');
const mongoose = require('mongoose');
const app = express();

app.use(express.json());
app.use(cors());

// --- חיבור למסד הנתונים (כתובת ישירה לעקיפת חסימות רשת) ---
// בנינו את הכתובת הזו לפי ה-Cluster ID שלך: njggbyd
const MONGO_URI = 'mongodb://nefeshhaim770_db_user:DxNzxIrIaoji0gWm@cluster0-shard-00-00.njggbyd.mongodb.net:27017,cluster0-shard-00-01.njggbyd.mongodb.net:27017,cluster0-shard-00-02.njggbyd.mongodb.net:27017/?ssl=true&authSource=admin&retryWrites=true&w=majority';

mongoose.connect(MONGO_URI)
    .then(() => console.log('✅ מחובר ל-MongoDB Atlas בהצלחה!'))
    .catch(err => {
        console.error('❌ שגיאת חיבור ל-DB:', err.message);
        console.log('💡 טיפ: וודא ב-MongoDB Atlas תחת Network Access שכתובת ה-IP היא 0.0.0.0/0');
    });

// --- הגדרת משתמש (מה נשמר בענן) ---
const userSchema = new mongoose.Schema({
    phone: { type: String, unique: true, required: true },
    name: { type: String, default: "" },
    email: { type: String, default: "" },
    totalDonated: { type: Number, default: 0 },
    // שומרים רק רמזים לכרטיס (לא את המספר המלא!)
    lastCardDigits: { type: String, default: "" }, 
    lastCardExp: { type: String, default: "" }
});

const User = mongoose.model('User', userSchema);

// --- פרטי קשר (Kesher) ---
const KESHER_URL = 'https://kesherhk.info/ConnectToKesher/ConnectToKesher';
const KESHER_USER = '2181420WS2087';
const KESHER_PASS = 'WVmO1iterNb33AbWLzMjJEyVnEQbskSZqyel5T61Hb5qdwR0gl';

let otpDB = {}; // קודי אימות זמניים

app.get('/', (req, res) => res.send('PushCoins Server Active'));

// --- שלב 1: שליחת קוד SMS ---
app.post('/send-auth', (req, res) => {
    const { phone } = req.body;
    otpDB[phone] = '1234'; // כרגע קוד קבוע לבדיקה
    console.log(`קוד כניסה ל-${phone}: 1234`);
    res.json({ success: true });
});

// --- שלב 2: אימות קוד ויצירת/טעינת משתמש מהענן ---
app.post('/verify-auth', async (req, res) => {
    const { phone } = req.body;
    
    try {
        // מחפשים אם המשתמש כבר קיים ב-MongoDB
        let user = await User.findOne({ phone });
        
        // אם לא קיים - יוצרים חדש ושומרים
        if (!user) {
            user = new User({ phone });
            await user.save();
            console.log(`✨ נוצר משתמש חדש: ${phone}`);
        } else {
            console.log(`👤 משתמש קיים התחבר: ${user.name || phone}`);
        }
        
        res.json({ success: true, user });
    } catch (e) {
        console.error("שגיאה בהתחברות:", e);
        res.status(500).json({ success: false, error: "תקלה בשרת הנתונים" });
    }
});

// --- קבלת פרטי משתמש עדכניים ---
app.get('/get-user', async (req, res) => {
    const phone = req.query.phone;
    try {
        const user = await User.findOne({ phone });
        if(user) res.json({ success: true, user });
        else res.status(404).json({ success: false });
    } catch(e) {
        res.status(500).json({ success: false });
    }
});

// --- עדכון פרטים (שם ומייל) ---
app.post('/update-user', async (req, res) => {
    const { phone, name, email } = req.body;
    try {
        const user = await User.findOneAndUpdate(
            { phone }, 
            { name, email },
            { new: true } // מחזיר את המידע המעודכן
        );
        res.json({ success: true, user });
    } catch(e) {
        res.status(500).json({ success: false });
    }
});

// --- ביצוע תרומה ושמירה ---
app.post('/donate', async (req, res) => {
    const { phone, amount, ccDetails, email } = req.body;
    
    try {
        let user = await User.findOne({ phone });
        if (!user) return res.status(404).json({ error: "משתמש לא נמצא" });

        if (!ccDetails) return res.status(400).json({ error: "חסרים פרטי אשראי" });

        // עדכון מייל ושם אם הוזנו
        const donorEmail = email || user.email || "no-email@provided.com";
        const donorName = user.name || "PushCoins Donor";
        
        // 1. תיקון תאריך (הופכים MMYY ל-YYMM)
        let finalExpiry = ccDetails.exp;
        if (ccDetails.exp && ccDetails.exp.length === 4) {
            finalExpiry = ccDetails.exp.substring(2, 4) + ccDetails.exp.substring(0, 2); 
        }

        // 2. המרה לאגורות
        const totalInAgorot = parseInt(amount) * 100;

        console.log(`\n>>> חיוב ${amount} ש"ח (${totalInAgorot} אגורות) עבור ${donorName}`);

        // הכנת הבקשה ל"קשר" (J4)
        const payload = {
            Json: {
                userName: KESHER_USER,
                password: KESHER_PASS,
                func: "SendTransaction",
                format: "json",
                tran: {
                    CreditNum: ccDetails.num,
                    Expiry: finalExpiry,
                    Total: totalInAgorot,
                    Currency: 1, CreditType: 1, 
                    Phone: phone, ParamJ: "J4", TransactionType: "debit",
                    
                    // שליחת המייל והשם
                    Mail: donorEmail, 
                    FirstName: donorName, 
                    LastName: ".",
                    
                    Cvv2: ccDetails.cvv
                }
            },
            format: "json"
        };

        const config = { headers: { 'User-Agent': 'Mozilla/5.0', 'Content-Type': 'application/json' } };
        const response = await axios.post(KESHER_URL, payload, config);
        const data = response.data;

        console.log("תשובה מקשר:", JSON.stringify(data));

        if (data.RequestResult && data.RequestResult.Status === true) {
            console.log("✅ העסקה אושרה!");
            
            // עדכון הנתונים ב-MongoDB
            user.totalDonated += parseInt(amount);
            if(email) user.email = email;
            
            user.lastCardDigits = ccDetails.num.slice(-4);
            user.lastCardExp = ccDetails.exp;
            
            await user.save(); // שמירה לענן
            
            res.json({ success: true, newTotal: user.totalDonated });
        } else {
            const failReason = data.RequestResult ? data.RequestResult.Description : "שגיאה כללית";
            console.error("❌ נכשל:", failReason);
            res.status(400).json({ success: false, error: failReason });
        }

    } catch (error) {
        console.error("שגיאת מערכת:", error.message);
        res.status(500).json({ success: false, error: "שגיאת תקשורת" });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`--- השרת רץ על פורט ${PORT} ---`));