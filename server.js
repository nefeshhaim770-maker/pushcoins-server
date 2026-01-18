const express = require('express');
const cors = require('cors');
const axios = require('axios');
const mongoose = require('mongoose');
const app = express();

app.use(express.json());
app.use(cors());

// חיבור למסד הנתונים
mongoose.connect('mongodb+srv://nefeshhaim770_db_user:DxNzxIrIaoji0gWm@cluster0.njggbyd.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0')
    .then(() => console.log('✅ Connected to DB'))
    .catch(err => console.error('❌ DB Error', err));

// מודל משתמש פשוט וגמיש
const userSchema = new mongoose.Schema({
    phone: String,
    name: String,
    email: String,
    tz: String,
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
        const { phone } = req.body;
        let user = await User.findOne({ phone });
        if (!user) { user = new User({ phone }); await user.save(); }
        res.json({ success: true, user });
    } catch (e) { 
        console.error("Auth Error:", e.message);
        res.status(500).json({ success: false, error: "שגיאת התחברות" }); 
    }
});

app.post('/donate', async (req, res) => {
    const { phone, amount, ccDetails, email, fullName, tz, useToken } = req.body;
    
    try {
        // 1. מציאת המשתמש
        let user = await User.findOne({ phone });
        if (!user) throw new Error("User not found in DB");

        // 2. הכנת הנתונים ל"קשר"
        let tranData = {
            Total: parseInt(amount) * 100,
            Currency: 1, CreditType: 1, Phone: phone,
            FirstName: (fullName || "Torem").split(" ")[0],
            LastName: (fullName || "Torem").split(" ").slice(1).join(" ") || ".",
            Mail: email || "a@a.com",
            UniqNum: tz || "", // השדה שפתר את הבעיה הקודמת
            ParamJ: "J4", TransactionType: "debit"
        };

        // 3. בחירה בין טוקן לכרטיס חדש
        if (useToken && user.token) {
            tranData.Token = user.token; // שימוש בטוקן השמור
        } else if (ccDetails) {
            let exp = ccDetails.exp;
            if (exp.length === 4) exp = exp.substring(2,4) + exp.substring(0,2); // פורמט YYMM
            tranData.CreditNum = ccDetails.num;
            tranData.Expiry = exp;
            tranData.Cvv2 = ccDetails.cvv;
        } else {
            return res.status(400).json({ success: false, error: "חסרים פרטי תשלום" });
        }

        // 4. שליחה לקשר
        const response = await axios.post(KESHER_URL, {
            Json: { userName: KESHER_USER, password: KESHER_PASS, func: "SendTransaction", format: "json", tran: tranData },
            format: "json"
        });

        console.log("KESHER RESPONSE:", JSON.stringify(response.data));

        // 5. עיבוד התוצאה
        if (response.data.RequestResult?.Status === true) {
            user.totalDonated += parseInt(amount);
            user.name = fullName; user.email = email; user.tz = tz;
            
            // שמירת הטוקן החדש
            const rToken = response.data.RequestResult.Token;
            if (rToken) user.token = rToken;
            
            if (!useToken && ccDetails) user.lastCardDigits = ccDetails.num.slice(-4);
            
            await user.save();
            res.json({ success: true, newTotal: user.totalDonated });
        } else {
            const kesherError = response.data.RequestResult?.Description || "העסקה נדחתה";
            res.status(400).json({ success: false, error: kesherError });
        }

    } catch (e) {
        console.error("CRITICAL DONATE ERROR:", e.message);
        // מחזירים 400 במקום 500 כדי שהאפליקציה תדע להציג הודעה למשתמש ולא תקרוס
        res.status(400).json({ success: false, error: "שגיאת תקשורת. נסה שוב בעוד דקה." });
    }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
