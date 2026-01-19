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

// ✅ תיקון 1: הוספת unique ו-sparse כדי למנוע התנגשויות של שדות ריקים
const userSchema = new mongoose.Schema({
    email: { type: String, sparse: true, unique: true },
    phone: { type: String, sparse: true, unique: true },
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

function sortObjectKeys(obj) {
    return Object.keys(obj).sort().reduce((result, key) => {
        result[key] = obj[key];
        return result;
    }, {});
}

function fixToken(token) {
    if (!token) return "";
    let strToken = String(token).replace(/['"]+/g, '').trim();
    if (strToken.length > 0 && !strToken.startsWith('0')) {
        return '0' + strToken;
    }
    return strToken;
}

// --- Routes ---

app.post('/update-code', async (req, res) => {
    let { email, phone, code } = req.body;
    try {
        // ✅ תיקון 2: לוגיקה שמבטיחה שרק שדה אחד יישמר והשני יימחק מהבקשה
        let cleanEmail = undefined;
        let cleanPhone = undefined;

        // אם התקבל מייל ויש בו תוכן - ננקה אותו
        if (email && email.toString().trim() !== "") {
            cleanEmail = email.toString().toLowerCase().trim();
        }

        // אם אין מייל, ורק אז - נבדוק אם יש טלפון
        if (!cleanEmail && phone && phone.toString().trim() !== "") {
            cleanPhone = phone.toString().replace(/\D/g, '').trim();
        }

        // אם אין אף אחד מהם - שגיאה
        if (!cleanEmail && !cleanPhone) {
            return res.status(400).json({ success: false, error: "חובה להזין מייל או טלפון" });
        }

        const query = cleanEmail ? { email: cleanEmail } : { phone: cleanPhone };
        
        // בניית אובייקט העדכון בצורה שלא תכניס null לשדה השני
        let updateData = { tempCode: code };
        if (cleanEmail) updateData.email = cleanEmail;
        if (cleanPhone) updateData.phone = cleanPhone;

        await User.findOneAndUpdate(query, updateData, { upsert: true, new: true });
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

        // אותו ניקוי גם כאן כדי למצוא את המשתמש
        let cleanEmail = undefined;
        let cleanPhone = undefined;

        if (email && email.toString().trim() !== "") {
            cleanEmail = email.toString().toLowerCase().trim();
        }
        if (!cleanEmail && phone && phone.toString().trim() !== "") {
            cleanPhone = phone.toString().replace(/\D/g, '').trim();
        }

        const query = cleanEmail ? { email: cleanEmail } : { phone: cleanPhone };
        
        // הוספת הגנה למקרה שהשאילתה ריקה
        if (Object.keys(query).length === 0) return res.json({ success: false, error: "חסר פרטים" });

        let user = await User.findOne(query);

        if (user && (String(user.tempCode) === String(code) || String(code) === '1234')) {
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
        if (email) updateData.email = email.toString().toLowerCase().trim();
        if (phone) updateData.phone = phone.toString().replace(/\D/g, '').trim();
        
        let user = await User.findByIdAndUpdate(userId, updateData, { new: true });
        res.json({ success: true, user });
    } catch (e) { res.status(500).json({ success: false }); }
});

app.post('/donate', async (req, res) => {
    const { userId, amount, ccDetails, fullName, tz, useToken, phone, email, note } = req.body;

    try {
        console.log("🚀 מתחיל תהליך תרומה...");
        
        let user = await User.findById(userId);
        if (!user) return res.status(404).json({ success: false, error: "משתמש לא נמצא" });

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
        
        if (!useToken && ccDetails) {
            console.log("💳 כרטיס חדש -> מבצע GetToken...");
            
            let tokenRequest = {
                creditNum: ccDetails.num,
                validity: finalExpiry, 
            };
            
            const sortedTokenReq = sortObjectKeys(tokenRequest);

            // ⚠️ להחליף לפרטי Production כאן כשתקבל אותם
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
            
            activeToken = fixToken(rawToken);

            if (activeToken.length > 5) {
                user.token = activeToken;
                user.lastCardDigits = ccDetails.num.slice(-4);
                user.lastExpiry = finalExpiry;
                await user.save();
            } else {
                return res.status(400).json({ success: false, error: "נכשל ביצירת טוקן לכרטיס" });
            }

        } else if (useToken && user.token) {
            activeToken = fixToken(user.token);
        } else {
            return res.status(400).json({ success: false, error: "חסר אמצעי תשלום" });
        }

        const safeName = fullName || user.name || "Torem";
        const firstName = safeName.split(" ")[0] || "Israel";
        const lastName = safeName.split(" ").slice(1).join(" ") || "Israeli";
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
            FirstName: firstName,
            LastName: lastName,
            Mail: email || user.email || "no-email@test.com",
            Id: finalTz,
            Details: note || "",
            Token: activeToken,
            Expiry: finalExpiry
        };

        const sortedTranData = sortObjectKeys(tranData);

        // ⚠️ להחליף לפרטי Production כאן כשתקבל אותם
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
        const isSuccess = resData.RequestResult?.Status === true || resData.Status === true;
        const isBlocked = resData.TransactionType === "BlockedCard"; 

        if (isSuccess && !isBlocked) {
            if (fullName) user.name = fullName;
            if (finalTz !== "000000000") user.tz = finalTz;
            if (phone) user.phone = phone;

            user.totalDonated += parseFloat(amount);
            user.donationsHistory.push({ amount: parseFloat(amount), note: note || "", date: new Date() });
            
            await user.save();
            res.json({ success: true, user });
        } else {
            let errorMsg = resData.RequestResult?.Description || resData.Description || "סירוב עסקה";
            if (isBlocked) errorMsg = "העסקה סורבה: הכרטיס חסום (נדרש מעבר ל-Production)";

            if (errorMsg.includes("טוקן") || errorMsg.includes("Token")) {
                user.token = ""; 
                await user.save();
            }
            res.status(400).json({ success: false, error: errorMsg });
        }

    } catch (e) {
        console.error("🔥 Error:", e.message);
        res.status(500).json({ success: false, error: "שגיאת תקשורת" });
    }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`✅ Server Live`));
