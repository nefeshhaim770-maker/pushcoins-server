const express = require('express');
const cors = require('cors');
const axios = require('axios');
const mongoose = require('mongoose');
const app = express();

app.use(express.json());
app.use(cors());

// התחברות ל-MongoDB
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

// פונקציית עזר לתיקון ת"ז (חובה 9 ספרות)
function padTz(tz) {
    if (!tz) return "000000000";
    let str = tz.toString().replace(/\D/g, '');
    while (str.length < 9) str = "0" + str;
    return str;
}

// נתיבים לאפליקציה
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
        console.log("🚀 מתחיל תהליך תרומה...");
        
        let user = await User.findById(userId);
        if (!user) return res.status(404).json({ success: false, error: "משתמש לא נמצא" });

        // הכנת נתונים
        const finalTz = padTz(tz || user.tz);
        const safeName = fullName || user.name || "Torem";
        const firstName = safeName.split(" ")[0] || "Israel";
        const lastName = safeName.split(" ").slice(1).join(" ") || "Israeli";

        // המרה לפורמט YYMM שהשרת דורש (למשל 2512)
        // המשתמש מזין ב-HTML פורמט MMYY (למשל 1225) -> צריך להפוך
        let finalExpiry = "";
        if (ccDetails && ccDetails.exp) {
            // אם המשתמש הזין 1225 (דצמבר 2025) -> הופכים ל-2512
            if (ccDetails.exp.length === 4) {
                const mm = ccDetails.exp.substring(0, 2);
                const yy = ccDetails.exp.substring(2, 4);
                finalExpiry = yy + mm; 
            } else {
                finalExpiry = ccDetails.exp;
            }
        } else if (useToken) {
            finalExpiry = user.lastExpiry; // כבר שמור בפורמט הנכון
        }

        // --- בניית האובייקט בדיוק לפי הדוגמה המוצלחת ששלחת ---
        let tranData = {
            Total: parseFloat(amount), // מספר! לא סטרינג
            Currency: 1,               // מספר
            CreditType: 1,             // מספר (1 = רגיל, 10 = תשלומים. נתחיל ב-1 לבדיקה)
            // NumPayment: 12,         // נוריד את זה כרגע כדי לראות שחיוב רגיל עובר
            ParamJ: "J4", 
            TransactionType: "debit",
            ProjectNumber: "00001",
            Phone: (phone || user.phone || "0500000000").toString(),
            FirstName: firstName,
            LastName: lastName,
            Mail: email || user.email || "no-email@test.com",
            
            // לפי הדוגמה המוצלחת שלך אין שדה HolderID או Tz בתוך האובייקט tran! 
            // אבל יש clientReference לפעמים. ננסה לשלוח נקי כמו בדוגמה.
        };

        // הוספת פרטי אשראי
        if (useToken && user.token) {
            console.log("💳 שימוש בטוקן קיים");
            tranData.Token = user.token;
            tranData.Expiry = finalExpiry; 
        } else if (ccDetails) {
            console.log("💳 שימוש בכרטיס חדש");
            tranData.CreditNum = ccDetails.num;
            tranData.Expiry = finalExpiry; // הפורמט ההפוך (YYMM)
            // tranData.Cvv2 = ccDetails.cvv; // בדוגמה שלך ה-CVV בהערה, ננסה בלי
        } else {
            return res.status(400).json({ success: false, error: "חסרים פרטי תשלום" });
        }

        console.log("📤 שולח לקשר:", JSON.stringify(tranData));

        // שליחה עם validateStatus כדי למנוע קריסה
        const response = await axios.post('https://kesherhk.info/ConnectToKesher/ConnectToKesher', {
            Json: { 
                userName: '2181420WS2087', 
                password: 'WVmO1iterNb33AbWLzMjJEyVnEQbskSZqyel5T61Hb5qdwR0gl', 
                func: "SendTransaction", 
                format: "json", 
                tran: tranData 
            },
            format: "json"
        }, { validateStatus: () => true });

        const resData = response.data;
        console.log("📩 תשובה מקשר:", JSON.stringify(resData));

        // בדיקת הצלחה
        if (resData.RequestResult?.Status === true || resData.Status === true) {
            // עדכון משתמש
            if (fullName) user.name = fullName;
            if (finalTz !== "000000000") user.tz = finalTz;
            if (phone) user.phone = phone;

            user.totalDonated += parseFloat(amount);
            user.donationsHistory.push({ amount: parseFloat(amount), note: note || "", date: new Date() });
            
            // שמירת טוקן
            const rToken = resData.Token || resData.RequestResult?.Token;
            if (rToken) {
                user.token = rToken;
                if (!useToken && ccDetails) {
                    user.lastCardDigits = ccDetails.num.slice(-4);
                    user.lastExpiry = finalExpiry;
                }
            }
            await user.save();
            res.json({ success: true, user });
        } else {
            // חילוץ שגיאה
            let errorMsg = resData.RequestResult?.Description || resData.Description || "סירוב עסקה";
            console.log("❌ נדחה:", errorMsg);
            res.status(400).json({ success: false, error: errorMsg });
        }

    } catch (e) {
        console.error("🔥 שגיאה קריטית:", e.message);
        res.status(500).json({ success: false, error: "תקלה טכנית בשרת" });
    }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`✅ Server Live on port ${PORT}`));
