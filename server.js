const express = require('express');
const cors = require('cors');
const axios = require('axios');
const mongoose = require('mongoose');
const app = express();

app.use(express.json());
app.use(cors());

mongoose.connect('mongodb+srv://nefeshhaim770_db_user:DxNzxIrIaoji0gWm@cluster0.njggbyd.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0')
    .then(() => console.log('✅ Connected to DB'))
    .catch(err => console.error(err));

const userSchema = new mongoose.Schema({
    phone: String, name: String, email: String, tz: String,
    totalDonated: { type: Number, default: 0 },
    token: { type: String, default: "" },
    lastCardDigits: String
});
const User = mongoose.model('User', userSchema);

const KESHER_URL = 'https://kesherhk.info/ConnectToKesher/ConnectToKesher';
const KESHER_USER = '2181420WS2087';
const KESHER_PASS = 'WVmO1iterNb33AbWLzMjJEyVnEQbskSZqyel5T61Hb5qdwR0gl';

app.post('/verify-auth', async (req, res) => {
    try {
        let user = await User.findOne({ phone: req.body.phone });
        if (!user) { user = new User({ phone: req.body.phone }); await user.save(); }
        res.json({ success: true, user });
    } catch (e) { res.status(500).json({ success: false }); }
});

app.post('/donate', async (req, res) => {
    const { phone, amount, ccDetails, email, fullName, tz, useToken } = req.body;
    try {
        let user = await User.findOne({ phone });
        
        let tranData = {
            Total: parseInt(amount) * 100, Currency: 1, CreditType: 1, Phone: phone,
            FirstName: (fullName || "T").split(" ")[0],
            LastName: (fullName || "T").split(" ").slice(1).join(" ") || ".",
            Mail: email || "a@a.com",
            // --- הניסיון הסופי לפיצוח הת"ז ב"קשר" ---
            PersonalId: tz || "",      // שם שדה נפוץ בקשר
            UniqNum: tz || "",         // מה שראינו בלוג
            Comment: "ת.ז: " + tz,      // גיבוי בשדה הערות כדי שיופיע בדו"ח
            // ------------------------------------
            ParamJ: "J4", TransactionType: "debit"
        };

        if (useToken && user?.token) {
            tranData.Token = user.token;
        } else {
            let exp = ccDetails.exp;
            if (exp.length === 4) exp = exp.substring(2,4) + exp.substring(0,2);
            tranData.CreditNum = ccDetails.num;
            tranData.Expiry = exp;
            tranData.Cvv2 = ccDetails.cvv;
        }

        const response = await axios.post(KESHER_URL, {
            Json: { userName: KESHER_USER, password: KESHER_PASS, func: "SendTransaction", format: "json", tran: tranData },
            format: "json"
        });

        if (response.data.RequestResult?.Status === true) {
            user.totalDonated += parseInt(amount);
            user.name = fullName; user.email = email; user.tz = tz;
            
            // חילוץ טוקן - בדיקה של כל האפשרויות
            const rToken = response.data.RequestResult.Token || response.data.RequestResult.CardId;
            if (rToken) user.token = rToken;
            if (!useToken && ccDetails) user.lastCardDigits = ccDetails.num.slice(-4);
            
            await user.save();
            res.json({ success: true, newTotal: user.totalDonated, user: user });
        } else {
            res.status(400).json({ success: false, error: response.data.RequestResult?.Description });
        }
    } catch (e) { res.status(500).json({ success: false, error: "שגיאת שרת" }); }
});

app.listen(10000);
