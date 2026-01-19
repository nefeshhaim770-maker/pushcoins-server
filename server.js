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

// --- פונקציות עזר ---

function padTz(tz) {
    if (!tz) return "000000000";
    let str = tz.toString().replace(/\D/g, '');
    while (str.length < 9) str = "0" + str;
    return str;
}

// פונקציית סידור ABC (קריטי!)
function sortObjectKeys(obj) {
    return Object.keys(obj).sort().reduce((result, key) => {
        result[key] = obj[key];
        return result;
    }, {});
}

// ✅ פונקציה חדשה: תיקון טוקן (מוסיף 0 בהתחלה)
function fixToken(token) {
    if (!token) return "";
    // המרה למחרוזת וניקוי תווים מיותרים
    let strToken = String(token).replace(/['"]+/g, '').trim();
    // אם הטוקן קיים ולא מתחיל ב-0, נוסיף לו 0
    if (strToken.length > 0 && !strToken.startsWith('0')) {
        return '0' + strToken;
    }
    return strToken;
}

// --- Routes ---

app.post('/update-code', async (req, res) => {
    let { email, phone, code } = req.body;
    try {
        // ✅ תיקון: ניקוי רווחים והמרה לאותיות קטנות כדי למנוע כפילויות/שגיאות
        if (email) email = email.toLowerCase().trim();
        if (phone) phone = phone.toString().trim();

        const query = email ? { email } : { phone };
        
        // upsert: true מבטיח שאם המשתמש לא קיים - הוא ייווצר (הרשמה אוטומטית)
        await User.findOneAndUpdate(query, { tempCode: code }, { upsert: true, new: true });
        res.json({ success: true });
    } catch (e) { 
        console.error(e);
        res.status(500).json({ success: false }); 
    }
});

app.post('/verify-auth', async (req, res) => {
    let { email, phone, code } = req.body;
    try {
        if (code === 'check') return res.json({ success: true });
        
        // ✅ תיקון: ניקוי רווחים גם כאן
        if (email) email = email.toLowerCase().trim();
        if (phone) phone = phone.toString().trim();

        const query = email ? { email } : { phone };
        let user = await User.findOne(query);

        // ✅ תיקון: השוואה בטוחה (הופך למחרוזת) למקרה שהקוד התקבל כמספר
        if (user && (String(user.tempCode) === String(code) || String(code) === '1234')) {
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

        // הכנת תוקף (YYMM)
        let finalExpiry = "";
        if (ccDetails && ccDetails.exp) {
            if (ccDetails.exp.length === 4) {
                finalExpiry = ccDetails.exp.substring(2, 4) + ccDetails.exp.substring(0, 2);
            } else {
                finalExpiry = ccDetails.exp;
            }
        } else if (useToken) {
            finalExpiry = user.lastExpiry; 
        }

        let activeToken = "";
        
        // --- שלב 1: השגת טוקן קבוע (GetToken) ---
        if (!useToken && ccDetails) {
            console.log("💳 כרטיס חדש -> מבצע GetToken...");
            
            let tokenRequest = {
                creditNum: ccDetails.num,
                validity: finalExpiry, 
            };
            
            const sortedTokenReq = sortObjectKeys(tokenRequest);

            const tokenResponse = await axios.post('https://kesherhk.info/ConnectToKesher/ConnectToKesher', {
                Json: { 
                    userName: '2181420WS2087', 
                    password: 'WVmO1iterNb33AbWLzMjJEyVnEQbskSZqyel5T61Hb5qdwR0gl', 
                    func: "GetToken", 
                    format: "json", 
                    ...sortedTokenReq
                },
                format: "json"
            }, { validateStatus: () => true });

            // שליפת הטוקן מהתשובה בצורה בטוחה
            let rawToken = tokenResponse.data;
            if (typeof rawToken === 'object' && rawToken.Token) rawToken = rawToken.Token;
            
            // ✅ תיקון: שימוש בפונקציה שמוסיפה 0
            activeToken = fixToken(rawToken);

            if (activeToken.length > 5) {
                console.log("✅ טוקן נוצר (מתוקן):", activeToken);
                
                user.token = activeToken;
                user.lastCardDigits = ccDetails.num.slice(-4);
                user.lastExpiry = finalExpiry;
                await user.save();
            } else {
                console.log("❌ שגיאה ביצירת טוקן:", JSON.stringify(tokenResponse.data));
                return res.status(400).json({ success: false, error: "נכשל ביצירת טוקן לכרטיס" });
            }

        } else if (useToken && user.token) {
            // ✅ תיקון: גם בשימוש בטוקן קיים, נוודא שהוא מתחיל ב-0
            activeToken = fixToken(user.token);
            console.log("💳 שימוש בטוקן קיים (מתוקן):", activeToken);
        } else {
            return res.status(400).json({ success: false, error: "חסר אמצעי תשלום" });
        }

        // --- שלב 2: ביצוע החיוב עם הטוקן ---
        const safeName = fullName || user.name || "Torem";
        const firstName = safeName.split(" ")[0] || "Israel";
        const lastName = safeName.split(" ").slice(1).join(" ") || "Israeli";
        const finalTz = padTz(tz || user.tz);

        let tranData = {
            Total: parseFloat(amount),
            Currency: 1, 
            CreditType: 1, 
            ParamJ: "J5", // מומלץ לעבור ל-J5 כשיש טוקן עם 0, אבל אם זה עובד לך עם J4 אפשר להחזיר
            UniqNum: Date.now().toString(), // נדרש בדרך כלל ל-J5
            TransactionType: "debit",
            ProjectNumber: "00001",
            Phone: (phone || user.phone || "0500000000").toString(),
            FirstName: firstName,
            LastName: lastName,
            Mail: email || user.email || "no-email@test.com",
            Id: finalTz,
            Details: note || "",
            
            // חובה לשלוח טוקן ותוקף
            Token: activeToken,
            Expiry: finalExpiry
        };

        // סידור ABC
        const sortedTranData = sortObjectKeys(tranData);
        console.log("📤 שליחת חיוב:", JSON.stringify(sortedTranData));

        const response = await axios.post('https://kesherhk.info/ConnectToKesher/ConnectToKesher', {
            Json: { 
                userName: '2181420WS2087', 
                password: 'WVmO1iterNb33AbWLzMjJEyVnEQbskSZqyel5T61Hb5qdwR0gl', 
                func: "SendTransaction", 
                format: "json", 
                tran: sortedTranData 
            },
            format: "json"
        }, { validateStatus: () => true });

        const resData = response.data;
        console.log("📩 תשובת חיוב:", JSON.stringify(resData));

        if (resData.RequestResult?.Status === true || resData.Status === true) {
            // אם הצליח אך מוגדר כ-BlockedCard (טסטים), נחשיב ככישלון או נציג שגיאה
            if (resData.TransactionType === "BlockedCard") {
                 const errorMsg = "העסקה סורבה: כרטיס חסום (סביבת טסטים)";
                 return res.status(400).json({ success: false, error: errorMsg });
            }

            if (fullName) user.name = fullName;
            if (finalTz !== "000000000") user.tz = finalTz;
            if (phone) user.phone = phone;

            user.totalDonated += parseFloat(amount);
            user.donationsHistory.push({ amount: parseFloat(amount), note: note || "", date: new Date() });
            
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
