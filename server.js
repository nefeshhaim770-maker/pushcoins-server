const express = require('express');
const cors = require('cors');
const axios = require('axios');
const mongoose = require('mongoose');
const app = express();

app.use(express.json());
app.use(cors());

// --- חיבור חסין תקלות למסד הנתונים ---
// חזרנו לכתובת המלאה והישירה כדי למנוע ניתוקים
const MONGO_URI = 'mongodb://nefeshhaim770_db_user:DxNzxIrIaoji0gWm@cluster0-shard-00-00.njggbyd.mongodb.net:27017,cluster0-shard-00-01.njggbyd.mongodb.net:27017,cluster0-shard-00-02.njggbyd.mongodb.net:27017/?ssl=true&authSource=admin&retryWrites=true&w=majority';

mongoose.connect(MONGO_URI)
    .then(() => console.log('✅ Connected to MongoDB Atlas'))
    .catch(err => console.error('❌ MongoDB Connection Error:', err));

// --- מודל משתמש ---
const userSchema = new mongoose.Schema({
    phone: { type: String, unique: true, required: true },
    name: { type: String, default: "" },
    email: { type: String, default: "" },
    totalDonated: { type: Number, default: 0 },
    lastCardDigits: { type: String, default: "" }, 
    lastCardExp: { type: String, default: "" }
});
const User = mongoose.model('User', userSchema);

const KESHER_URL = 'https://kesherhk.info/ConnectToKesher/ConnectToKesher';
const KESHER_USER = '2181420WS2087';
const KESHER_PASS = 'WVmO1iterNb33AbWLzMjJEyVnEQbskSZqyel5T61Hb5qdwR0gl';

app.get('/', (req, res) => res.send('PushCoins Server is Live!'));

// 1. שליחת קוד (רק בכאילו)
app.post('/send-auth', (req, res) => {
    console.log(`Code requested for ${req.body.phone}`);
    res.json({ success: true });
});

// 2. אימות וכניסה (תיקון: תמיד מקבל 1234)
app.post('/verify-auth', async (req, res) => {
    const { phone, code } = req.body;
    
    // --- התיקון: בדיקה קשיחה ---
    // לא משנה מה קרה לזיכרון של השרת, 1234 תמיד יעבוד
    if (code !== '1234') {
        return res.json({ success: false, error: "קוד שגוי" });
    }
    
    try {
        console.log("Searching for user:", phone);
        let user = await User.findOne({ phone });
        
        if (!user) {
            console.log("Creating new user...");
            user = new User({ phone });
            await user.save();
        }
        res.json({ success: true, user });
    } catch (e) {
        console.error("Login Error:", e);
        // מחזיר את השגיאה האמיתית במקום "קוד שגוי"
        res.status(500).json({ success: false, error: "שגיאת חיבור למסד נתונים" });
    }
});

// 3. עדכון פרופיל
app.post('/update-user', async (req, res) => {
    const { phone, name, email } = req.body;
    try {
        const user = await User.findOneAndUpdate({ phone }, { name, email }, { new: true });
        res.json({ success: true, user });
    } catch(e) {
        res.status(500).json({ success: false });
    }
});

// 4. תרומה
app.post('/donate', async (req, res) => {
    const { phone, amount, ccDetails, email } = req.body;
    
    try {
        let user = await User.findOne({ phone });
        if (!user) return res.status(404).json({ error: "User not found" });

        const totalAgorot = parseInt(amount) * 100;
        let finalExpiry = ccDetails.exp;
        if (finalExpiry.length === 4) finalExpiry = finalExpiry.substring(2,4) + finalExpiry.substring(0,2);

        const payload = {
            Json: {
                userName: KESHER_USER,
                password: KESHER_PASS,
                func: "SendTransaction",
                format: "json",
                tran: {
                    CreditNum: ccDetails.num, Expiry: finalExpiry, Total: totalAgorot, Cvv2: ccDetails.cvv,
                    Currency: 1, CreditType: 1, Phone: phone, ParamJ: "J4", TransactionType: "debit",
                    Mail: email || user.email || "app@donation.com",
                    FirstName: user.name || "Donor", LastName: "."
                }
            },
            format: "json"
        };

        const config = { headers: { 'User-Agent': 'Mozilla/5.0', 'Content-Type': 'application/json' } };
        const response = await axios.post(KESHER_URL, payload, config);
        
        if (response.data.RequestResult && response.data.RequestResult.Status === true) {
            user.totalDonated += parseInt(amount);
            user.lastCardDigits = ccDetails.num.slice(-4);
            user.lastCardExp = ccDetails.exp;
            if (email) user.email = email;
            await user.save();
            
            res.json({ success: true, newTotal: user.totalDonated });
        } else {
            res.status(400).json({ success: false, error: response.data.RequestResult?.Description || "דחייה" });
        }

    } catch (error) {
        console.error("Donation Error:", error);
        res.status(500).json({ success: false, error: "תקלת תקשורת" });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
