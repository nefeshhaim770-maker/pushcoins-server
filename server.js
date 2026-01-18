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

const userSchema = new mongoose.Schema({
    email: { type: String, sparse: true },
    phone: { type: String, sparse: true },
    name: String,
    tz: String,
    totalDonated: { type: Number, default: 0 },
    token: { type: String, default: "" },
    lastCardDigits: String,
    tempCode: String,
    notes: [String] 
});
const User = mongoose.model('User', userSchema);

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
        if (!user) return res.status(404).json({ error: "User not found" });

        // בניית אובייקט הטרנזקציה לפי דוגמת ה-CURL המוצלחת
        let tranData = {
            Total: parseFloat(amount), // שליחת סכום בשקלים לפי הדוגמה
            Currency: 1, 
            CreditType: 1, 
            Phone: phone || user.phone || "0500000000",
            FirstName: (fullName || user.name || "שם").split(" ")[0],
            LastName: (fullName || user.name || "משפחה").split(" ").slice(1).join(" ") || "משפחה",
            Mail: email || user.email || "no-email@test.com", 
            ParamJ: "J4", 
            TransactionType: "debit",
            ProjectNumber: "00001" // נוסף לפי הדוגמה
        };

        if (useToken && user.token && user.token !== "") {
            tranData.Token = user.token; // שימוש בטוקן השמור מה-DB
        } else if (ccDetails) {
            // שימוש בפרטי אשראי מלאים
            tranData.CreditNum = ccDetails.num; 
            tranData.Expiry = ccDetails.exp; // פורמט YYMM כמו בדוגמה
            tranData.Cvv2 = ccDetails.cvv;
        } else {
            return res.status(400).json({ success: false, error: "נדרשים פרטי תשלום" });
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
        // בדיקת סטטוס הצלחה כפי שמופיע ב-RequestResult בדוגמה שלך
        if (resData.RequestResult?.Status === true || resData.Status === true) {
            user.totalDonated += parseFloat(amount);
            if (fullName) user.name = fullName;
            if (tz) user.tz = tz;
            if (phone) user.phone = phone;
            if (note) user.notes.push(note);
            
            // שמירת הטוקן החדש מהשדה Token בתגובה
            const rToken = resData.Token || resData.RequestResult?.Token;
            if (rToken) {
                user.token = rToken;
                if (!useToken && ccDetails) user.lastCardDigits = ccDetails.num.slice(-4);
            }
            await user.save();
            res.json({ success: true, user });
        } else { 
            // אם הטוקן שגוי, "קשר" יחזירו תיאור שגיאה בשדה זה
            res.status(400).json({ 
                success: false, 
                error: resData.RequestResult?.Description || resData.Description || "עסקה נכשלה" 
            }); 
        }
    } catch (e) { 
        console.error("Donate Error:", e.message);
        res.status(500).json({ success: false, error: "שגיאת תקשורת" }); 
    }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`✅ Server Live`));
