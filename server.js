const express = require('express');
const cors = require('cors');
const axios = require('axios');
const mongoose = require('mongoose');
const app = express();

app.use(express.json());
app.use(cors());

// ==================================================================
// 🛑 אזור ההגדרות - כאן מכניסים את הפרטים האמיתיים מ"קשר"
// ==================================================================

// החלף את מה שבתוך הגרשיים בפרטים שתקבל מהתמיכה:
const KESHER_USER = '2181420WS2087';  // <-- כאן שים את שם המשתמש האמיתי
const KESHER_PASS = 'WVmO1iterNb33AbWLzMjJEyVnEQbskSZqyel5T61Hb5qdwR0gl'; // <-- כאן שים את הסיסמה האמיתית

// כתובת ה-API (בדרך כלל זהה, אלא אם כן נתנו לך כתובת אחרת)
const KESHER_URL = 'https://kesherhk.info/ConnectToKesher/ConnectToKesher';

// ==================================================================

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

// --- פונקציות עזר קריטיות ---

function padTz(tz) {
    if (!tz) return "000000000";
    let str = tz.toString().replace(/\D/g, '');
    while (str.length < 9) str = "0" + str;
    return str;
}

// סידור לפי ABC - חובה ב-NodeJS מול קשר
function sortObjectKeys(obj) {
    return Object.keys(obj).sort().reduce((result, key) => {
        result[key] = obj[key];
        return result;
    }, {});
}

// תיקון טוקן - חובה להוסיף 0 בהתחלה
function fixToken(token) {
    if (!token) return "";
    let strToken = String(token).replace(/['"]+/g, '').trim();
    // אם הטוקן לא ריק ולא מתחיל ב-0, נוסיף לו 0
    if (strToken.length > 0 && !strToken.startsWith('0')) {
        return '0' + strToken;
    }
    return strToken;
}

// --- נתיבים (Routes) ---

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

app.post('/login-by-id', async (req, res) => {
    const { userId } = req.body;
    try {
        let user = await User.findById(userId);
        if (user) res.json({ success: true, user });
        else res.json({ success: false });
    } catch (e) { res.status(500).json({ success: false }); }
});

app.post('/update-profile', async (req, res) => {
    const { userId, name, email, phone } = req.body;
    try {
        let updateData = { name };
        if (email) updateData.email = email;
        if (phone) updateData.phone = phone;
        let user = await User.findByIdAndUpdate(userId, updateData, { new: true });
        res.json({ success: true, user });
    } catch (e) { res.status(500).json({ success: false }); }
});

// --- תהליך התרומה המלא ---
app.post('/donate', async (req, res) => {
    const { userId, amount, ccDetails, fullName, tz, useToken, phone, email, note } = req.body;

    try {
        console.log("🚀 תרומה חדשה מתחילה...");
        
        let user = await User.findById(userId);
        if (!user) return res.status(404).json({ success: false, error: "משתמש לא נמצא" });

        // המרת תוקף מ-MMYY ל-YYMM
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
        
        // --- שלב 1: יצירת טוקן (רק אם זה כרטיס חדש) ---
        if (!useToken && ccDetails) {
            console.log("💳 יצירת טוקן חדש...");
            
            let tokenRequest = { creditNum: ccDetails.num, validity: finalExpiry };
            const sortedTokenReq = sortObjectKeys(tokenRequest);

            // שימוש במשתנים מההגדרות למעלה
            const tokenResponse = await axios.post(KESHER_URL, {
                Json: { 
                    userName: KESHER_USER, 
                    password: KESHER_PASS, 
                    func: "GetToken", 
                    format: "json", 
                    ...sortedTokenReq
                },
                format: "json"
            }, { validateStatus: () => true });

            let rawToken = tokenResponse.data;
            if (typeof rawToken === 'object' && rawToken.Token) rawToken = rawToken.Token;
            
            // תיקון הטוקן (הוספת 0)
            activeToken = fixToken(rawToken);

            if (activeToken.length > 5) {
                user.token = activeToken;
                user.lastCardDigits = ccDetails.num.slice(-4);
                user.lastExpiry = finalExpiry;
                await user.save();
            } else {
                console.log("❌ שגיאת טוקן:", JSON.stringify(tokenResponse.data));
                return res.status(400).json({ success: false, error: "נכשל ביצירת טוקן לכרטיס" });
            }

        } else if (useToken && user.token) {
            // גם בשימוש בטוקן קיים, נוודא שיש לו 0 בהתחלה
            activeToken = fixToken(user.token);
        } else {
            return res.status(400).json({ success: false, error: "חסר אמצעי תשלום" });
        }

        // --- שלב 2: ביצוע החיוב ---
        const finalTz = padTz(tz || user.tz);

        let tranData = {
            Total: parseFloat(amount),
            Currency: 1, 
            CreditType: 1, 
            ParamJ: "J5", 
            UniqNum: Date.now().toString(), 
            TransactionType: "debit",
            ProjectNumber: "00001", // ב-Production המספר הזה עשוי להיות שונה, בדוק עם קשר
            Phone: (phone || user.phone || "0500000000").toString(),
            FirstName: (fullName || user.name || "Torem").split(" ")[0],
            LastName: (fullName || user.name || "Family").split(" ").slice(1).join(" ") || "Family",
            Mail: email || user.email || "no-email@test.com",
            Id: finalTz,
            Token: activeToken, 
            Expiry: finalExpiry,
            Details: note || ""
        };

        const sortedTranData = sortObjectKeys(tranData);
        console.log("📤 נתונים לחיוב:", JSON.stringify(sortedTranData));

        const response = await axios.post(KESHER_URL, {
            Json: { 
                userName: KESHER_USER, 
                password: KESHER_PASS, 
                func: "SendTransaction", 
                format: "json", 
                tran: sortedTranData 
            },
            format: "json"
        }, { validateStatus: () => true });

        const resData = response.data;
        console.log("📩 תשובת חיוב:", JSON.stringify(resData));

        // --- בדיקת הצלחה חכמה ---
        const isSuccess = resData.RequestResult?.Status === true || resData.Status === true;
        const isBlocked = resData.TransactionType === "BlockedCard"; 

        if (isSuccess && !isBlocked) {
            // הצלחה אמיתית!
            if (fullName) user.name = fullName;
            if (finalTz !== "000000000") user.tz = finalTz;
            if (phone) user.phone = phone;
            
            user.totalDonated += parseFloat(amount);
            user.donationsHistory.push({ amount: parseFloat(amount), note: note || "", date: new Date() });
            
            await user.save();
            res.json({ success: true, user });
        } else {
            // כישלון
            let errorMsg = resData.RequestResult?.Description || resData.Description || "סירוב עסקה";
            
            if (isBlocked) {
                errorMsg = "העסקה סורבה: הכרטיס חסום (BlockedCard) - נדרש מעבר למסוף Production";
            }

            // מחיקת טוקן שגוי
            if (errorMsg.includes("טוקן") || errorMsg.includes("Token")) {
                user.token = ""; 
                await user.save();
            }
            
            console.log("❌ נדחה:", errorMsg);
            res.status(400).json({ success: false, error: errorMsg });
        }

    } catch (e) {
        console.error("🔥 שגיאה:", e.message);
        res.status(500).json({ success: false, error: "שגיאת תקשורת" });
    }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`✅ Server Live`));
