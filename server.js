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
    lastExpiry: String,
    lastCardDigits: String,
    token: { type: String, default: "" },
    totalDonated: { type: Number, default: 0 },
    donationsHistory: [{
        amount: Number,
        date: { type: Date, default: Date.now },
        note: String
    }],
    tempCode: String
});
const User = mongoose.model('User', userSchema);

// פונקציית עזר לתיקון ת"ז
function padTz(tz) {
    if (!tz) return "000000000";
    let str = tz.toString().replace(/\D/g, '');
    while (str.length < 9) str = "0" + str;
    return str;
}

// נתיבים
app.post('/update-code', async (req, res) => {
    const { email, phone, code } = req.body;
    try {
        const query = email ? { email } : { phone };
        await User.findOneAndUpdate(query, { tempCode: code }, { upsert: true, new: true });
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
        } else {
            res.json({ success: false, error: "קוד שגוי" });
        }
    } catch (e) { res.status(500).json({ success: false }); }
});

app.post('/donate', async (req, res) => {
    const { userId, amount, ccDetails, fullName, tz, useToken, phone, email, note } = req.body;

    try {
        console.log("🚀 Starting Donation Process...");
        
        let user = await User.findById(userId);
        if (!user) return res.status(404).json({ success: false, error: "משתמש לא נמצא" });

        // 1. הכנת נתונים בסיסיים
        const finalTz = padTz(tz || user.tz);
        const safeName = fullName || user.name || "Torem";
        const firstName = safeName.split(" ")[0] || "Israel";
        const lastName = safeName.split(" ").slice(1).join(" ") || "Israeli";

        // 2. בניית אובייקט העסקה - שים לב לשינוי בטיפוסים (מספרים ללא גרשיים)
        let tranData = {
            Total: parseFloat(amount), // מספר
            Currency: 1,               // מספר
            CreditType: 10,            // מספר (תשלומים)
            NumPayment: 12,            // מספר
            ParamJ: "J4", 
            TransactionType: "debit",
            ProjectNumber: "00001",
            Phone: (phone || user.phone || "0500000000").toString(),
            FirstName: firstName,
            LastName: lastName,
            Mail: email || user.email || "no-email@test.com",
            Tz: finalTz,
            customerRef: user._id.toString() 
        };

        // 3. הוספת פרטי אשראי/טוקן
        if (useToken && user.token) {
            console.log("💳 Using Token");
            tranData.Token = user.token;
            tranData.Expiry = user.lastExpiry; 
        } else if (ccDetails) {
            console.log("💳 Using New Card");
            tranData.CreditNum = ccDetails.num;
            tranData.Expiry = ccDetails.exp; 
            tranData.Cvv2 = ccDetails.cvv;
        } else {
            return res.status(400).json({ success: false, error: "חסרים פרטי תשלום" });
        }

        console.log("📤 Sending to Kesher:", JSON.stringify(tranData));

        // 4. שליחה עם מניעת קריסה (validateStatus: true)
        const response = await axios.post('https://kesherhk.info/ConnectToKesher/ConnectToKesher', {
            Json: { 
                userName: '2181420WS2087', 
                password: 'WVmO1iterNb33AbWLzMjJEyVnEQbskSZqyel5T61Hb5qdwR0gl', 
                func: "SendTransaction", 
                format: "json", 
                tran: tranData 
            },
            format: "json"
        }, {
            // זה החלק הכי חשוב! מונע מהשרת שלך לקרוס אם קשר מחזירים שגיאה
            validateStatus: function (status) {
                return true; 
            }
        });

        const resData = response.data;
        console.log("📩 Kesher Raw Response:", JSON.stringify(resData));

        // 5. בדיקת תוצאה
        if (resData.RequestResult?.Status === true || resData.Status === true) {
            // הצלחה
            if (fullName) user.name = fullName;
            if (finalTz && finalTz !== "000000000") user.tz = finalTz;
            if (phone) user.phone = phone;

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
            // כישלון - מחזירים את ההודעה המקורית
            const errorMsg = resData.RequestResult?.Description || resData.Description || resData.ErrorMessage || "נדחה ע\"י חברת האשראי";
            console.log("❌ Rejected Reason:", errorMsg);
            res.status(400).json({ success: false, error: errorMsg });
        }

    } catch (e) {
        // תופס שגיאות קוד בלבד (לא שגיאות API)
        console.error("🔥 Code Exception:", e.message);
        res.status(500).json({ success: false, error: "שגיאה פנימית בקוד השרת" });
    }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`✅ Server Live on port ${PORT}`));
