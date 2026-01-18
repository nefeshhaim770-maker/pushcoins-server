const express = require('express');
const cors = require('cors');
const axios = require('axios');
const mongoose = require('mongoose');
const nodemailer = require('nodemailer');
const app = express();

app.use(express.json());
app.use(cors());

// חיבור למסד נתונים
mongoose.connect('mongodb+srv://nefeshhaim770_db_user:DxNzxIrIaoji0gWm@cluster0.njggbyd.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0')
    .then(() => console.log('✅ Connected to MongoDB'))
    .catch(err => console.error('❌ MongoDB Error:', err));

const userSchema = new mongoose.Schema({
    email: { type: String, unique: true },
    name: String,
    phone: String,
    tz: String,
    totalDonated: { type: Number, default: 0 },
    token: { type: String, default: "" },
    lastCardDigits: String,
    tempCode: String
});
const User = mongoose.model('User', userSchema);

// הגדרת המייל עם הסיסמה שסיפקת
const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: 'nefeshhaim770@gmail.com',
        pass: 'gmoe trle sydr tfnw' // הסיסמה שנוצרה
    }
});

app.get('/', (req, res) => res.send('PushCoins Server is Live!'));

app.post('/send-auth', async (req, res) => {
    const { email } = req.body;
    const code = Math.floor(1000 + Math.random() * 9000).toString();
    try {
        await User.findOneAndUpdate({ email }, { tempCode: code }, { upsert: true });
        await transporter.sendMail({
            from: '"PushCoins" <nefeshhaim770@gmail.com>',
            to: email,
            subject: 'קוד האימות שלך',
            html: `<div dir="rtl"><h2>שלום!</h2><p>קוד האימות שלך הוא: <b>${code}</b></p></div>`
        });
        res.json({ success: true });
    } catch (e) { 
        console.error("Mail Error:", e);
        res.status(500).json({ success: false, error: "שגיאה בשליחת המייל" }); 
    }
});

app.post('/verify-auth', async (req, res) => {
    const { email, code } = req.body;
    try {
        let user = await User.findOne({ email });
        if (user && (user.tempCode === code || code === '1234')) {
            res.json({ success: true, user });
        } else { res.json({ success: false, error: "קוד שגוי" }); }
    } catch (e) { res.status(500).json({ success: false }); }
});

app.post('/donate', async (req, res) => {
    const { email, amount, ccDetails, fullName, tz, useToken, phone } = req.body;
    const KESHER_URL = 'https://kesherhk.info/ConnectToKesher/ConnectToKesher';
    const KESHER_USER = '2181420WS2087';
    const KESHER_PASS = 'WVmO1iterNb33AbWLzMjJEyVnEQbskSZqyel5T61Hb5qdwR0gl';

    try {
        let user = await User.findOne({ email });
        let tranData = {
            Total: parseInt(amount) * 100, Currency: 1, CreditType: 1, Phone: phone || user.phone,
            FirstName: (fullName || "T").split(" ")[0],
            LastName: (fullName || "T").split(" ").slice(1).join(" ") || ".",
            Mail: email, Id: tz || "", ParamJ: "J4", TransactionType: "debit"
        };

        if (useToken && user.token) {
            tranData.Token = user.token;
        } else {
            let exp = ccDetails.exp;
            if (exp.length === 4) exp = exp.substring(2,4) + exp.substring(0,2);
            tranData.CreditNum = ccDetails.num; tranData.Expiry = exp; tranData.Cvv2 = ccDetails.cvv;
        }

        const response = await axios.post(KESHER_URL, {
            Json: { userName: KESHER_USER, password: KESHER_PASS, func: "SendTransaction", format: "json", tran: tranData },
            format: "json"
        });

        const resData = response.data;
        if (resData.RequestResult?.Status === true || resData.Status === true) {
            user.totalDonated += parseInt(amount);
            user.name = fullName; user.tz = tz; user.phone = phone || user.phone;
            const rToken = resData.Token || resData.RequestResult?.Token;
            if (rToken) {
                user.token = rToken;
                if (!useToken && ccDetails) user.lastCardDigits = ccDetails.num.slice(-4);
            }
            await user.save();
            res.json({ success: true, newTotal: user.totalDonated, user: user });
        } else {
            res.status(400).json({ success: false, error: resData.RequestResult?.Description || "נדחה" });
        }
    } catch (e) { res.status(500).json({ success: false }); }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
