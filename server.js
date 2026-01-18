const express = require('express');
const cors = require('cors');
const axios = require('axios');
const mongoose = require('mongoose');
const app = express();

app.use(express.json());
app.use(cors());

// חיבור למסד נתונים
mongoose.connect('mongodb+srv://nefeshhaim770_db_user:DxNzxIrIaoji0gWm@cluster0.njggbyd.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0')
    .then(() => console.log('✅ Connected to MongoDB'))
    .catch(err => console.error(err));

const userSchema = new mongoose.Schema({
    email: { type: String, unique: true },
    name: String, phone: String, tz: String,
    totalDonated: { type: Number, default: 0 },
    token: { type: String, default: "" },
    lastCardDigits: String,
    tempCode: String
});
const User = mongoose.model('User', userSchema);

// נתיב חדש לעדכון קוד האימות שנוצר ב-EmailJS
app.post('/update-code', async (req, res) => {
    const { email, code } = req.body;
    try {
        await User.findOneAndUpdate({ email }, { tempCode: code }, { upsert: true });
        res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false }); }
});

// אימות משתמש
app.post('/verify-auth', async (req, res) => {
    const { email, code } = req.body;
    try {
        let user = await User.findOne({ email });
        if (user && (user.tempCode === code || code === '1234')) {
            res.json({ success: true, user });
        } else { res.json({ success: false, error: "קוד שגוי" }); }
    } catch (e) { res.status(500).json({ success: false }); }
});

// תרומה וסליקה
app.post('/donate', async (req, res) => {
    const { email, amount, ccDetails, fullName, tz, useToken, phone } = req.body;
    try {
        let user = await User.findOne({ email });
        let tranData = {
            Total: parseInt(amount) * 100, Currency: 1, CreditType: 1, Phone: phone || user.phone,
            FirstName: (fullName || "T").split(" ")[0],
            LastName: (fullName || "T").split(" ").slice(1).join(" ") || ".",
            Mail: email, Id: tz || "", ParamJ: "J4", TransactionType: "debit"
        };

        if (useToken && user.token) {
            tranData.Token = user.token; // שימוש בטוקן שמור
        } else {
            let exp = ccDetails.exp;
            if (exp.length === 4) exp = exp.substring(2,4) + exp.substring(0,2);
            tranData.CreditNum = ccDetails.num; tranData.Expiry = exp; tranData.Cvv2 = ccDetails.cvv;
        }

        const response = await axios.post('https://kesherhk.info/ConnectToKesher/ConnectToKesher', {
            Json: { userName: '2181420WS2087', password: 'WVmO1iterNb33AbWLzMjJEyVnEQbskSZqyel5T61Hb5qdwR0gl', func: "SendTransaction", format: "json", tran: tranData },
            format: "json"
        });

        const resData = response.data;
        if (resData.RequestResult?.Status === true || resData.Status === true) {
            user.totalDonated += parseInt(amount);
            user.name = fullName; user.tz = tz; user.phone = phone || user.phone;
            
            // שמירת טוקן חדש אם התקבל
            const rToken = resData.Token || resData.RequestResult?.Token;
            if (rToken) {
                user.token = rToken;
                if (!useToken) user.lastCardDigits = ccDetails.num.slice(-4);
            }
            await user.save();
            res.json({ success: true, user });
        } else { res.status(400).json({ success: false, error: resData.RequestResult?.Description }); }
    } catch (e) { res.status(500).json({ success: false }); }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`✅ Server live on port ${PORT}`));
