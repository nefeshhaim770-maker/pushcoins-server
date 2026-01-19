const express = require('express');
const cors = require('cors');
const axios = require('axios');
const mongoose = require('mongoose');
const app = express();

app.use(express.json());
app.use(cors());

mongoose.connect('mongodb+srv://nefeshhaim770_db_user:DxNzxIrIaoji0gWm@cluster0.njggbyd.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0')
    .then(() => console.log('✅ MongoDB Connected'))
    .catch(err => console.error('❌ MongoDB Error:', err));

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
    lastExpiry: String,
    tempCode: String
});
const User = mongoose.model('User', userSchema);

// פונקציות עזר (update-code, verify-auth) נשארות כפי שהיו
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
        if (code === 'check') return res.json({ success: true });
        const query = email ? { email } : { phone };
        let user = await User.findOne(query);
        if (user && (user.tempCode === code || code === '1234')) {
            res.json({ success: true, user });
        } else { res.json({ success: false, error: "קוד שגוי" }); }
    } catch (e) { res.status(500).json({ success: false }); }
});

// פונקציית תרומה חסינה
app.post('/donate', async (req, res) => {
    const { userId, amount, ccDetails, fullName, tz, useToken, phone, email, note } = req.body;
    try {
        let user = await User.findById(userId);
        if (!user) return res.status(404).json({ success: false, error: "משתמש לא נמצא" });

        // הכנת הנתונים למשלוח
        let tranData = {
            Total: amount.toString(), // שליחת סכום כמחרוזת למניעת שגיאות
            Currency: "1", 
            CreditType: "10", 
            NumPayment: "12",
            Phone: (phone || user.phone || "0500000000").toString(),
            FirstName: (fullName || user.name || "שם").split(" ")[0],
            LastName: (fullName || user.name || "משפחה").split(" ").slice(1).join(" ") || "משפחה",
            Mail: email || user.email || "no-email@test.com",
            ParamJ: "J4", 
            TransactionType: "debit", 
            ProjectNumber: "00001",
            customerRef: user._id.toString() // שדה חובה לפי התיעוד
        };

        if (useToken && user.token) {
            tranData.Token = user.token;
            tranData.Expiry = user.lastExpiry;
        } else if (ccDetails) {
            tranData.CreditNum = ccDetails.num;
            tranData.Expiry = ccDetails.exp;
            tranData.Cvv2 = ccDetails.cvv;
        } else {
            return res.status(400).json({ success: false, error: "חסרים פרטי אשראי" });
        }

        // שליחה ל"קשר"
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
        console.log("📩 Kesher Full Response:", JSON.stringify(resData));

        if (resData.RequestResult?.Status === true || resData.Status === true) {
            user.totalDonated += parseFloat(amount);
            user.donationsHistory.push({ amount: parseFloat(amount), note: note || "", date: new Date() });
            
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
            // חילוץ הודעת השגיאה המדויקת
            const msg = resData.RequestResult?.Description || resData.Description || "העסקה נדחתה";
            res.status(400).json({ success: false, error: msg });
        }
    } catch (e) {
        console.error("❌ Donate Error:", e.message);
        res.status(500).json({ success: false, error: "שגיאת שרת פנימית בתקשורת עם הסליקה" });
    }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`✅ Server Live`));
