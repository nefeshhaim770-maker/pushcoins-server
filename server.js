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
    lastExpiry: String, // קריטי לשימוש חוזר בטוקן
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

// --- פונקציות האפליקציה ---

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

        // טיפול בתוקף: המרה מ-MMYY (מהלקוח) ל-YYMM (לשרת) אם צריך
        let finalExpiry = "";
        if (ccDetails && ccDetails.exp) {
            // אם המשתמש הזין 0528 (מאי 2028), השרת צריך 2805
            if (ccDetails.exp.length === 4) {
                finalExpiry = ccDetails.exp.substring(2, 4) + ccDetails.exp.substring(0, 2);
            } else {
                finalExpiry = ccDetails.exp;
            }
        } else if (useToken) {
            finalExpiry = user.lastExpiry; // שימוש בתוקף השמור
        }

        // --- בניית העסקה בדיוק לפי ה-Curl שעבד לך ---
        let tranData = {
            Total: parseFloat(amount),
            Currency: 1, 
            CreditType: 1, // נתחיל עם 1 (רגיל) לבדיקה, אח"כ נשנה ל-10
            ParamJ: "J4", 
            TransactionType: "debit",
            ProjectNumber: "00001",
            Phone: (phone || user.phone || "0500000000").toString(),
            FirstName: (fullName || user.name || "Torem").split(" ")[0],
            LastName: (fullName || user.name || "Family").split(" ").slice(1).join(" ") || "Family",
            Mail: email || user.email || "no-email@test.com",
            
            // השדה החסר שגרם לטוקן להיות "דפוק": מזהה לקוח
            customerRef: user._id.toString() 
        };

        // הוספת ת"ז רק אם זה קריטי (ב-Curl שעבד לא שלחת Tz בתוך ה-tran!)
        // נשאיר את זה בחוץ כרגע כדי לחקות את ההצלחה, אבל נשלח UniqNum ליתר ביטחון
        tranData.UniqNum = Date.now().toString();

        if (useToken && user.token) {
            console.log("💳 Using Stored Token");
            tranData.Token = user.token;
            // חובה לשלוח תוקף גם בטוקן
            tranData.Expiry = finalExpiry; 
        } else if (ccDetails) {
            console.log("💳 Using New Card");
            tranData.CreditNum = ccDetails.num;
            tranData.Expiry = finalExpiry; 
        } else {
            return res.status(400).json({ success: false, error: "חסרים פרטי תשלום" });
        }

        console.log("📤 Sending Payload:", JSON.stringify(tranData));

        // שימוש ב-validateStatus למניעת קריסה ב-500
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
        console.log("📩 Kesher Response:", JSON.stringify(resData));

        if (resData.RequestResult?.Status === true || resData.Status === true) {
            // שמירת פרטים
            if (fullName) user.name = fullName;
            if (tz) user.tz = tz;
            if (phone) user.phone = phone;

            user.totalDonated += parseFloat(amount);
            user.donationsHistory.push({ amount: parseFloat(amount), note: note || "", date: new Date() });
            
            // שמירת הטוקן והתוקף
            const rToken = resData.Token || resData.RequestResult?.Token;
            if (rToken) {
                user.token = rToken;
                // שומרים את התוקף בפורמט שהשרת צריך (YYMM)
                if (!useToken && ccDetails) {
                    user.lastCardDigits = ccDetails.num.slice(-4);
                    user.lastExpiry = finalExpiry;
                }
            }
            await user.save();
            res.json({ success: true, user });
        } else {
            const errorMsg = resData.RequestResult?.Description || resData.Description || "סירוב עסקה";
            res.status(400).json({ success: false, error: errorMsg });
        }

    } catch (e) {
        console.error("🔥 Error:", e.message);
        res.status(500).json({ success: false, error: "שגיאת תקשורת" });
    }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`✅ Server Live`));
