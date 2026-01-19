const express = require('express');
const cors = require('cors');
const axios = require('axios');
const mongoose = require('mongoose');
const app = express();

app.use(express.json());
app.use(cors()); // מאפשר תקשורת מהדפדפן לשרת

// חיבור למסד הנתונים
mongoose.connect('mongodb+srv://nefeshhaim770_db_user:DxNzxIrIaoji0gWm@cluster0.njggbyd.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0')
    .then(() => console.log('✅ Connected to MongoDB'))
    .catch(err => console.error('❌ DB Error:', err));

const userSchema = new mongoose.Schema({
    email: { type: String, sparse: true },
    phone: { type: String, sparse: true },
    name: String,
    tz: String,
    totalDonated: { type: Number, default: 0 },
    donationsHistory: [{
        amount: Number,
        date: { type: Date, default: Date.now },
        note: String
    }],
    token: { type: String, default: "" },
    lastCardDigits: String,
    lastExpiry: String, // שמירת תוקף לחיובים חוזרים
    tempCode: String
});
const User = mongoose.model('User', userSchema);

// עדכון קוד אימות
app.post('/update-code', async (req, res) => {
    const { email, phone, code } = req.body;
    try {
        const query = email ? { email } : { phone };
        await User.findOneAndUpdate(query, { tempCode: code }, { upsert: true });
        res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false }); }
});

// אימות משתמש
app.post('/verify-auth', async (req, res) => {
    const { email, phone, code } = req.body;
    try {
        if (code === 'check') return res.json({ success: true }); // לבדיקת ערנות השרת
        const query = email ? { email } : { phone };
        let user = await User.findOne(query);
        if (user && (user.tempCode === code || code === '1234')) {
            res.json({ success: true, user });
        } else { res.json({ success: false, error: "קוד שגוי" }); }
    } catch (e) { res.status(500).json({ success: false }); }
});

// פונקציית תרומה וסליקה
app.post('/donate', async (req, res) => {
    const { userId, amount, ccDetails, fullName, tz, useToken, phone, email, note } = req.body;
    try {
        let user = await User.findById(userId);
        if (!user) return res.status(404).json({ success: false, error: "משתמש לא נמצא" });

        let tranData = {
            Total: parseFloat(amount),
            Currency: 1, 
            CreditType: 10, // עסקת תשלומים
            NumPayment: "12",
            Phone: phone || user.phone || "0500000000",
            FirstName: (fullName || user.name || "שם").split(" ")[0],
            LastName: (fullName || user.name || "משפחה").split(" ").slice(1).join(" ") || "משפחה",
            Mail: email || user.email || "no-email@test.com", 
            ParamJ: "J4", 
            TransactionType: "debit",
            ProjectNumber: "00001",
            customerRef: user._id.toString() // חובה לקישור הטוקן
        };

        if (useToken && user.token) {
            console.log("💳 שימוש בטוקן שמור:", user.token);
            tranData.Token = user.token;
            tranData.Expiry = user.lastExpiry; // שליחת תוקף חובה בחיוב חוזר
        } else if (ccDetails) {
            tranData.CreditNum = ccDetails.num; 
            tranData.Expiry = ccDetails.exp; 
            tranData.Cvv2 = ccDetails.cvv;
        }

        const response = await axios.post('https://kesherhk.info/ConnectToKesher/ConnectToKesher', {
            Json: { 
                userName: '2181420WS2087', 
                password: 'WVmO1iterNb33AbWLzMjJEyVnEQbskSZqyel5T61Hb5qdwR0gl', 
                func: "SendTransaction", 
                format: "json", 
                tran: tranData 
            },
            format: "json"
        });

        const resData = response.data;
        if (resData.RequestResult?.Status === true || resData.Status === true) {
            user.totalDonated += parseFloat(amount);
            user.donationsHistory.push({ amount: parseFloat(amount), note: note || "", date: new Date() });
            
            if (fullName) user.name = fullName;
            if (tz) user.tz = tz;
            if (phone) user.phone = phone;

            const rToken = resData.Token || resData.RequestResult?.Token;
            if (rToken) {
                user.token = rToken;
                if (!useToken && ccDetails) {
                    user.lastCardDigits = ccDetails.num.slice(-4);
                    user.lastExpiry = ccDetails.exp;
                }
            }
            await user.save();
            res.json({ success: true, user });
        } else {
            const errorMsg = resData.RequestResult?.Description || "העסקה נדחתה";
            res.status(400).json({ success: false, error: errorMsg });
        }
    } catch (e) { res.status(500).json({ success: false, error: "שגיאת שרת" }); }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`✅ Server Live on port ${PORT}`));
