const express = require('express');
const cors = require('cors');
const axios = require('axios');
const mongoose = require('mongoose');
const app = express();

app.use(express.json());
app.use(cors());

// --- חיבור למסד נתונים ---
const MONGO_URI = 'mongodb+srv://nefeshhaim770_db_user:DxNzxIrIaoji0gWm@cluster0.njggbyd.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0';

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

// --- הגדרות קשר (Kesher) ---
const KESHER_URL = 'https://kesherhk.info/ConnectToKesher/ConnectToKesher';
const KESHER_USER = '2181420WS2087';
const KESHER_PASS = 'WVmO1iterNb33AbWLzMjJEyVnEQbskSZqyel5T61Hb5qdwR0gl';

app.get('/', (req, res) => res.send('PushCoins Server is Live! 🚀'));

// --- 1. שליחת קוד (כרגע לוג בלבד) ---
app.post('/send-auth', (req, res) => {
    console.log("Send auth requested for:", req.body.phone);
    res.json({ success: true });
});

// --- 2. אימות (קוד קבוע 1234) ---
app.post('/verify-auth', async (req, res) => {
    const { phone, code } = req.body;
    if (code !== '1234') {
        return res.json({ success: false, error: "קוד שגוי" });
    }
    
    try {
        let user = await User.findOne({ phone });
        if (!user) {
            user = new User({ phone });
            await user.save();
        }
        res.json({ success: true, user });
    } catch (e) {
        console.error("Login Error:", e);
        // מצב חירום: כניסה גם ללא מסד נתונים
        res.json({ success: true, user: { phone, name: "", totalDonated: 0 } }); 
    }
});

// --- 3. עדכון פרופיל ---
app.post('/update-user', async (req, res) => {
    const { phone, name, email } = req.body;
    try {
        const user = await User.findOneAndUpdate({ phone }, { name, email }, { new: true });
        res.json({ success: true, user });
    } catch(e) {
        res.status(500).json({ success: false });
    }
});

// --- 4. תרומה (עם פיצול שם מלא) ---
app.post('/donate', async (req, res) => {
    const { phone, amount, ccDetails, email, fullName } = req.body;
    
    try {
        console.log(`Processing donation: ${amount} ILS from ${fullName}`);
        
        const totalAgorot = parseInt(amount) * 100;
        
        // סידור תוקף כרטיס
        let finalExpiry = ccDetails.exp;
        if (finalExpiry.length === 4) {
            finalExpiry = finalExpiry.substring(2,4) + finalExpiry.substring(0,2);
        }

        // פיצול שם מלא לשם פרטי ושם משפחה
        const cleanName = (fullName || "Torem").trim();
        const nameParts = cleanName.split(" ");
        const firstName = nameParts[0]; 
        const lastName = nameParts.length > 1 ? nameParts.slice(1).join(" ") : ".";

        const payload = {
            Json: {
                userName: KESHER_USER,
                password: KESHER_PASS,
                func: "SendTransaction",
                format: "json",
                tran: {
                    CreditNum: ccDetails.num,
                    Expiry: finalExpiry,
                    Total: totalAgorot,
                    Cvv2: ccDetails.cvv,
                    Currency: 1,
                    CreditType: 1,
                    Phone: phone,
                    Mail: email || "app@donate.com",
                    FirstName: firstName,
                    LastName: lastName,
                    ParamJ: "J4",
                    TransactionType: "debit"
                }
            },
            format: "json"
        };

        const response = await axios.post(KESHER_URL, payload);
        
        if (response.data.RequestResult && response.data.RequestResult.Status === true) {
            // הצלחה - שמירה ב-DB
            try {
                let user = await User.findOne({ phone });
                if(user) {
                    user.totalDonated += parseInt(amount);
                    if (fullName) user.name = fullName;
                    if (email) user.email = email;
                    user.lastCardDigits = ccDetails.num.slice(-4);
                    user.lastCardExp = ccDetails.exp;
                    await user.save();
                }
            } catch(dbError) {
                console.error("DB Save Error:", dbError);
            }
            
            res.json({ success: true, newTotal: (parseInt(amount)) });
        } else {
            const errMsg = response.data.RequestResult?.Description || "העסקה נדחתה";
            console.log("Transaction Failed:", errMsg);
            res.status(400).json({ success: false, error: errMsg });
        }

    } catch (error) {
        console.error("Server Error:", error);
        res.status(500).json({ success: false, error: "שגיאת שרת פנימית" });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
