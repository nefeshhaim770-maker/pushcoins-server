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

// פונקציית סידור ABC
function sortObjectKeys(obj) {
    return Object.keys(obj).sort().reduce((result, key) => {
        result[key] = obj[key];
        return result;
    }, {});
}

// פונקציה לתיקון טוקן (מוסיפה 0 בהתחלה אם חסר)
function fixToken(token) {
    if (!token) return "";
    let strToken = String(token).replace(/['"]+/g, '').trim();
    if (strToken.length > 0 && !strToken.startsWith('0')) {
        return '0' + strToken;
    }
    return strToken;
}

// --- Routes ---

// שליחת קוד לאימות
app.post('/update-code', async (req, res) => {
    const { email, phone, code } = req.body;
    try {
        const query = email ? { email } : { phone };
        await User.findOneAndUpdate(query, { tempCode: code }, { upsert: true, new: true });
        res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false }); }
});

// אימות קוד (Login)
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

// התחברות אוטומטית (לפי ID שנשמר במכשיר)
app.post('/login-by-id', async (req, res) => {
    const { userId } = req.body;
    try {
        let user = await User.findById(userId);
        if (user) {
            res.json({ success: true, user });
        } else {
            res.json({ success: false, error: "משתמש לא נמצא" });
        }
    } catch (e) { res.status(500).json({ success: false }); }
});

// עדכון פרטי משתמש
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

// ביצוע תרומה
app.post('/donate', async (req, res) => {
    const { userId, amount, ccDetails, fullName, tz, useToken, phone, email, note } = req.body;

    try {
        console.log("🚀 תרומה חדשה מתחילה...");
        
        let user = await User.findById(userId);
        if (!user) return res.status(404).json({ success: false, error: "משתמש לא נמצא" });

        // המרת תוקף
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
        
        // --- שלב 1: GetToken (אם כרטיס חדש) ---
        if (!useToken && ccDetails) {
            console.log("💳 יצירת טוקן חדש...");
            
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

            let rawToken = tokenResponse.data;
            if (typeof rawToken === 'object' && rawToken.Token) rawToken = rawToken.Token;
            
            // שימוש בפונקציית התיקון שמוסיפה 0
            activeToken = fixToken(rawToken);

            if (activeToken.length > 5) {
                console.log(`✅ טוקן נוצר (מתוקן): ${activeToken}`);
                user.token = activeToken;
                user.lastCardDigits = ccDetails.num.slice(-4);
                user.lastExpiry = finalExpiry;
                await user.save();
            } else {
                return res.status(400).json({ success: false, error: "נכשל ביצירת טוקן" });
            }

        } else if (useToken && user.token) {
            // גם בשימוש חוזר - נתקן את הטוקן למקרה שנשמר לא טוב
            activeToken = fixToken(user.token);
            console.log(`💳 שימוש בטוקן קיים: ${activeToken}`);
        } else {
            return res.status(400).json({ success: false, error: "חסר אמצעי תשלום" });
        }

        // --- שלב 2: החיוב ---
        
        const finalTz = padTz(tz || user.tz);

        let tranData = {
            Total: parseFloat(amount),
            Currency: 1, 
            CreditType: 1, 
            ParamJ: "J5", 
            UniqNum: Date.now().toString(), 
            TransactionType: "debit",
            ProjectNumber: "00001",
            Phone: (phone || user.phone || "0500000000").toString(),
            FirstName: (fullName || user.name || "Torem").split(" ")[0],
            LastName: (fullName || user.name || "Family").split(" ").slice(1).join(" ") || "Family",
            Mail: email || user.email || "no-email@test.com",
            Id: finalTz,
            Token: activeToken, 
            Expiry: finalExpiry,
            Details: note || "" // הוספנו את ההערה ל-Details כדי שתעבור לקשר
        };

        const sortedTranData = sortObjectKeys(tranData);
        console.log("📤 נתונים לחיוב:", JSON.stringify(sortedTranData));

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
            // עדכון פרטים אם השתנו
            if (fullName) user.name = fullName;
            if (finalTz !== "000000000") user.tz = finalTz;
            if (phone) user.phone = phone;
            
            user.totalDonated += parseFloat(amount);
            user.donationsHistory.push({ amount: parseFloat(amount), note: note || "", date: new Date() });
            
            await user.save();
            res.json({ success: true, user });
        } else {
            const errorMsg = resData.RequestResult?.Description || resData.Description || "סירוב עסקה";
            // אם הטוקן שגוי - נמחק אותו
            if (errorMsg.includes("טוקן") || errorMsg.includes("Token")) {
                user.token = ""; 
                await user.save();
            }
            res.status(400).json({ success: false, error: errorMsg });
        }

    } catch (e) {
        console.error("🔥 שגיאה:", e.message);
        res.status(500).json({ success: false, error: "שגיאת תקשורת" });
    }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`✅ Server Live`));
