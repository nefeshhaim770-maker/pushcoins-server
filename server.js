const express = require('express');
const cors = require('cors');
const axios = require('axios');
const mongoose = require('mongoose');
const app = express();

app.use(express.json());
app.use(cors());

// חיבור למסד נתונים (MongoDB)
const MONGO_URI = 'mongodb+srv://nefeshhaim770_db_user:DxNzxIrIaoji0gWm@cluster0.njggbyd.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0';
mongoose.connect(MONGO_URI).then(() => console.log('✅ Connected to MongoDB')).catch(err => console.error(err));

// מודל משתמש (כולל מקום לטוקן ות"ז)
const userSchema = new mongoose.Schema({
    phone: { type: String, unique: true, required: true },
    name: { type: String, default: "" },
    email: { type: String, default: "" },
    tz: { type: String, default: "" },
    totalDonated: { type: Number, default: 0 },
    token: { type: String, default: "" }, // כאן נשמר הטוקן לחיוב מהיר
    lastCardDigits: { type: String, default: "" }
});
const User = mongoose.model('User', userSchema);

const KESHER_URL = 'https://kesherhk.info/ConnectToKesher/ConnectToKesher';
const KESHER_USER = '2181420WS2087';
const KESHER_PASS = 'WVmO1iterNb33AbWLzMjJEyVnEQbskSZqyel5T61Hb5qdwR0gl';

app.get('/', (req, res) => res.send('PushCoins Server Live!'));

app.post('/send-auth', (req, res) => res.json({ success: true }));

app.post('/verify-auth', async (req, res) => {
    const { phone, code } = req.body;
    if (code !== '1234') return res.json({ success: false, error: "קוד שגוי" });
    try {
        let user = await User.findOne({ phone });
        if (!user) { user = new User({ phone }); await user.save(); }
        res.json({ success: true, user });
    } catch (e) { res.status(500).json({ success: false }); }
});

app.post('/donate', async (req, res) => {
    const { phone, amount, ccDetails, email, fullName, tz, useToken } = req.body;
    
    try {
        let user = await User.findOne({ phone });
        const totalAgorot = parseInt(amount) * 100;

        let tranData = {
            Total: totalAgorot,
            Currency: 1,
            CreditType: 1,
            Phone: phone,
            FirstName: (fullName || "Torem").split(" ")[0],
            LastName: (fullName || "Torem").split(" ").slice(1).join(" ") || ".",
            Mail: email || "app@donate.com",
            UniqNum: tz || "",        // ניסיון 1 לת"ז
            numAssociation: tz || "", // ניסיון 2 לת"ז (לפי ה-JSON ששלחת)
            ParamJ: "J4",
            TransactionType: "debit"
        };

        if (useToken && user && user.token) {
            tranData.Token = user.token; // שימוש בטוקן הקיים
        } else {
            let finalExpiry = ccDetails.exp;
            if (finalExpiry.length === 4) {
                // הפיכת MMYY ל-YYMM כנדרש
                finalExpiry = finalExpiry.substring(2, 4) + finalExpiry.substring(0, 2);
            }
            tranData.CreditNum = ccDetails.num;
            tranData.Expiry = finalExpiry;
            tranData.Cvv2 = ccDetails.cvv;
        }

        const payload = {
            Json: { userName: KESHER_USER, password: KESHER_PASS, func: "SendTransaction", format: "json", tran: tranData },
            format: "json"
        };

        const response = await axios.post(KESHER_URL, payload);
        console.log("RESPONSE FROM KESHER:", JSON.stringify(response.data));

        if (response.data.RequestResult?.Status === true) {
            if (user) {
                user.totalDonated += parseInt(amount);
                user.name = fullName;
                user.email = email;
                user.tz = tz;
                // חילוץ ושמירת הטוקן מהלוג
                const returnedToken = response.data.RequestResult.Token;
                if (returnedToken) user.token = returnedToken;
                if (!useToken) user.lastCardDigits = ccDetails.num.slice(-4);
                await user.save();
            }
            res.json({ success: true, newTotal: user.totalDonated });
        } else {
            res.status(400).json({ success: false, error: response.data.RequestResult?.Description || "נדחה" });
        }
    } catch (e) {
        res.status(500).json({ success: false, error: "שגיאת שרת" });
    }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
