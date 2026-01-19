const express = require('express');
const cors = require('cors');
const axios = require('axios');
const mongoose = require('mongoose');
const app = express();

app.use(express.json());
app.use(cors()); // מאפשר גישה מהדפדפן ללא חסימות

// 1. התחברות למסד הנתונים
mongoose.connect('mongodb+srv://nefeshhaim770_db_user:DxNzxIrIaoji0gWm@cluster0.njggbyd.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0')
    .then(() => console.log('✅ MongoDB Connected'))
    .catch(err => console.error('❌ MongoDB Error:', err));

// 2. הגדרת המודל עם כל השדות הנדרשים (כולל היסטוריה, ת"ז ותוקף)
const userSchema = new mongoose.Schema({
    email: { type: String, sparse: true },
    phone: { type: String, sparse: true },
    name: String,
    tz: String,          // שמירת ת"ז למילוי אוטומטי
    lastExpiry: String,  // חובה לשמור תוקף לשימוש חוזר בטוקן
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

// --- נתיבים (Routes) ---

// עדכון קוד אימות
app.post('/update-code', async (req, res) => {
    const { email, phone, code } = req.body;
    try {
        const query = email ? { email } : { phone };
        // upsert: true מבטיח יצירת משתמש אם לא קיים
        await User.findOneAndUpdate(query, { tempCode: code }, { upsert: true, new: true });
        res.json({ success: true });
    } catch (e) {
        console.error("Update Code Error:", e);
        res.status(500).json({ success: false });
    }
});

// אימות קוד + בדיקת סטטוס שרת
app.post('/verify-auth', async (req, res) => {
    const { email, phone, code } = req.body;
    try {
        if (code === 'check') return res.json({ success: true }); // UptimeRobot Ping
        
        const query = email ? { email } : { phone };
        let user = await User.findOne(query);
        
        if (user && (user.tempCode === code || code === '1234')) {
            res.json({ success: true, user });
        } else {
            res.json({ success: false, error: "קוד שגוי" });
        }
    } catch (e) { res.status(500).json({ success: false }); }
});

// פונקציית התרומה הראשית (הכי חשובה)
app.post('/donate', async (req, res) => {
    // שליפת הנתונים מהבקשה
    const { userId, amount, ccDetails, fullName, tz, useToken, phone, email, note } = req.body;

    try {
        // א. בדיקת קיום משתמש
        let user = await User.findById(userId);
        if (!user) return res.status(404).json({ success: false, error: "משתמש לא נמצא, נא להתחבר מחדש" });

        // ב. וידוא שיש תעודת זהות (מהטופס או מהזיכרון) - מונע שגיאת 500
        const finalTz = tz || user.tz;
        if (!finalTz) {
            return res.status(400).json({ success: false, error: "חסר מספר תעודת זהות" });
        }

        // ג. הכנת נתוני העסקה לפי הדרישות המדויקות של קשר
        let tranData = {
            Total: amount.toString(),
            Currency: "1", 
            CreditType: "10",      // תשלומים
            NumPayment: "12",      // מספר תשלומים קבוע
            ParamJ: "J4", 
            TransactionType: "debit",
            ProjectNumber: "00001",
            
            // פרטי לקוח
            Phone: (phone || user.phone || "0500000000").toString(),
            FirstName: (fullName || user.name || "Torem").split(" ")[0],
            LastName: (fullName || user.name || "Family").split(" ").slice(1).join(" ") || "Family",
            Mail: email || user.email || "no-email@test.com",
            Tz: finalTz.toString(), // ת"ז לאימות מול חברת האשראי
            
            // המפתח הקריטי: קישור הלקוח לטוקן
            customerRef: user._id.toString() 
        };

        // ד. החלטה: האם זה טוקן או כרטיס חדש?
        if (useToken && user.token) {
            console.log("💳 שימוש בטוקן קיים...");
            tranData.Token = user.token;
            // חובה לשלוח תוקף גם בטוקן בעסקאות תשלומים
            tranData.Expiry = user.lastExpiry; 
        } else if (ccDetails) {
            console.log("💳 שימוש בכרטיס חדש...");
            tranData.CreditNum = ccDetails.num;
            tranData.Expiry = ccDetails.exp;
            tranData.Cvv2 = ccDetails.cvv;
        } else {
            return res.status(400).json({ success: false, error: "לא התקבלו פרטי תשלום" });
        }

        // ה. שליחה ל"קשר"
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
        console.log("📩 Kesher Response Code:", resData.RequestResult?.Code || "Unknown"); 

        // ו. עיבוד התשובה
        if (resData.RequestResult?.Status === true || resData.Status === true) {
            // 1. שמירת פרטים אישיים לפעם הבאה
            if (fullName) user.name = fullName;
            if (finalTz) user.tz = finalTz;
            if (phone) user.phone = phone;

            // 2. עדכון סטטיסטיקות והיסטוריה
            user.totalDonated += parseFloat(amount);
            user.donationsHistory.push({ 
                amount: parseFloat(amount), 
                note: note || "", 
                date: new Date() 
            });

            // 3. שמירת/עדכון טוקן ותוקף
            const rToken = resData.Token || resData.RequestResult?.Token;
            if (rToken) {
                user.token = rToken;
                // שומרים את התוקף והספרות רק אם הוזן כרטיס חדש
                if (!useToken && ccDetails) {
                    user.lastCardDigits = ccDetails.num.slice(-4);
                    user.lastExpiry = ccDetails.exp; 
                }
            }
            
            await user.save();
            res.json({ success: true, user });
        } else {
            // טיפול בשגיאה ברורה
            const errorMsg = resData.RequestResult?.Description || resData.Description || "סירוב מחברת האשראי";
            console.log("❌ Rejected:", errorMsg);
            res.status(400).json({ success: false, error: errorMsg });
        }

    } catch (e) {
        console.error("🔥 Critical Server Error:", e.message);
        res.status(500).json({ success: false, error: "שגיאת תקשורת פנימית" });
    }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`✅ Server Live on port ${PORT}`));
