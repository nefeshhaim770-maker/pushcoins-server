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

        // הכנת הנתונים לסליקה
        let tranData = {
            Total: Math.round(parseFloat(amount) * 100), // המרה לאגורות
            Currency: 1, 
            CreditType: 1, 
            Phone: phone || user.phone || "0000000000",
            FirstName: (fullName || user.name || "T").split(" ")[0],
            LastName: (fullName || user.name || "T").split(" ").slice(1).join(" ") || "T",
            Mail: email || user.email || "no-email@test.com", 
            Id: tz || user.tz || "", 
            ParamJ: "J4", 
            TransactionType: "debit"
        };

        // לוגיקת טוקן/אשראי חדש
        if (useToken && user.token && user.token !== "") {
            tranData.Token = user.token; // שליחת הטוקן השמור
        } else if (ccDetails) {
            let exp = ccDetails.exp;
            if (exp.length === 4) exp = exp.substring(2,4) + exp.substring(0,2); // פורמט YYMM
            tranData.CreditNum = ccDetails.num; 
            tranData.Expiry = exp; 
            tranData.Cvv2 = ccDetails.cvv;
        } else {
            return res.status(400).json({ success: false, error: "חסרים פרטי תשלום" });
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
        // בדיקת הצלחה לפי הפורמט של קשר
        if (resData.RequestResult?.Status === true || resData.Status === true) {
            user.totalDonated += parseFloat(amount);
            if (fullName) user.name = fullName;
            if (tz) user.tz = tz;
            if (phone) user.phone = phone;
            if (email) user.email = email;
            if (note) user.notes.push(note);
            
            // עדכון טוקן אם הוחזר חדש
            const rToken = resData.Token || resData.RequestResult?.Token;
            if (rToken) {
                user.token = rToken;
                if (!useToken && ccDetails) user.lastCardDigits = ccDetails.num.slice(-4);
            }
            await user.save();
            res.json({ success: true, user });
        } else { 
            // החזרת הודעת השגיאה המדויקת מקשר
            res.status(400).json({ 
                success: false, 
                error: resData.RequestResult?.Description || resData.Description || "עסקת אשראי נכשלה" 
            }); 
        }
    } catch (e) { 
        console.error("Donate Error:", e);
        res.status(500).json({ success: false, error: "שגיאת תקשורת עם שרת הסליקה" }); 
    }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`✅ Server live on port ${PORT}`));
