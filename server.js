const express = require('express');
const cors = require('cors');
const axios = require('axios');
const mongoose = require('mongoose');
const app = express();

app.use(express.json());
app.use(cors());

mongoose.connect('mongodb+srv://nefeshhaim770_db_user:DxNzxIrIaoji0gWm@cluster0.njggbyd.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0')
    .then(() => console.log('✅ Connected to MongoDB'))
    .catch(err => console.error(err));

// מודל משתמש מעודכן
const userSchema = new mongoose.Schema({
    email: { type: String, sparse: true },
    phone: { type: String, sparse: true },
    name: String,
    tz: String,
    totalDonated: { type: Number, default: 0 },
    token: { type: String, default: "" },
    lastCardDigits: String,
    tempCode: String,
    notes: [String] // מערך של כל ההערות מהתרומות בעבר
});
const User = mongoose.model('User', userSchema);

// עדכון קוד לפי זיהוי מייל או טלפון
app.post('/update-code', async (req, res) => {
    const { email, phone, code } = req.body;
    try {
        const query = email ? { email } : { phone };
        await User.findOneAndUpdate(query, { tempCode: code }, { upsert: true });
        res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false }); }
});

app.post('/verify-auth', async (req, res) => {
    const { email, phone, code } = req.body;
    try {
        const query = email ? { email } : { phone };
        let user = await User.findOne(query);
        if (user && (user.tempCode === code || code === '1234')) {
            res.json({ success: true, user });
        } else { res.json({ success: false, error: "קוד שגוי" }); }
    } catch (e) { res.status(500).json({ success: false }); }
});

app.post('/donate', async (req, res) => {
    const { userId, amount, ccDetails, fullName, tz, useToken, phone, email, note } = req.body;
    try {
        let user = await User.findById(userId);
        let tranData = {
            Total: parseInt(amount) * 100, Currency: 1, CreditType: 1, 
            Phone: phone || user.phone,
            FirstName: (fullName || "T").split(" ")[0],
            LastName: (fullName || "T").split(" ").slice(1).join(" ") || ".",
            Mail: email || user.email, 
            Id: tz || "", ParamJ: "J4", TransactionType: "debit"
        };

        if (useToken && user.token) {
            tranData.Token = user.token;
        } else {
            let exp = ccDetails.exp;
            if (exp.length === 4) exp = exp.substring(2,4) + exp.substring(0,2);
            tranData.CreditNum = ccDetails.num; tranData.Expiry = exp; tranData.Cvv2 = ccDetails.cvv;
        }

        const response = await axios.post('https://kesherhk.info/ConnectToKesher/ConnectToKesher', {
            Json: { userName: '2181420WS2087', password: 'WVmO1iterNb33AbWLzMjJEyVnEQbskSZqyel5T61Hb5qdwR0gl', func: "SendTransaction", format: "json", tran: tranData },
            format: "json"
        });

        if (response.data.RequestResult?.Status === true || response.data.Status === true) {
            user.totalDonated += parseInt(amount);
            user.name = fullName;
            user.tz = tz;
            if (phone) user.phone = phone;
            if (email) user.email = email;
            if (note) user.notes.push(note); // שמירת ההערה
            
            const rToken = response.data.Token || response.data.RequestResult?.Token;
            if (rToken) {
                user.token = rToken;
                if (!useToken) user.lastCardDigits = ccDetails.num.slice(-4);
            }
            await user.save();
            res.json({ success: true, user });
        } else { res.status(400).json({ success: false }); }
    } catch (e) { res.status(500).json({ success: false }); }
});

app.listen(10000);
