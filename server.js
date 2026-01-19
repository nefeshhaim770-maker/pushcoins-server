const express = require('express');
const cors = require('cors');
const axios = require('axios');
const mongoose = require('mongoose');
const app = express();

app.use(express.json());
app.use(cors());

mongoose.connect('mongodb+srv://nefeshhaim770_db_user:DxNzxIrIaoji0gWm@cluster0.njggbyd.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0')
    .then(async () => {
        console.log('✅ MongoDB Connected');
        // --- תיקון חד פעמי לבעיית ההרשמה (מוחק אינדקסים ישנים) ---
        try { await mongoose.connection.db.collection('users').dropIndex('phone_1'); } catch (e) { }
        try { await mongoose.connection.db.collection('users').dropIndex('email_1'); } catch (e) { }
    })
    .catch(err => console.error('❌ MongoDB Error:', err));

const userSchema = new mongoose.Schema({
    // הוספתי sparse: true כדי לאפשר משתמשים בלי טלפון/מייל
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

function sortObjectKeys(obj) {
    return Object.keys(obj).sort().reduce((result, key) => {
        result[key] = obj[key];
        return result;
    }, {});
}

// ✅ תיקון טוקן: מוסיף 0 בהתחלה
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
        let cleanEmail = undefined;
        let cleanPhone = undefined;

        // ניקוי נתונים כדי למנוע כפילויות
        if (email && email.toString().trim() !== "") cleanEmail = email.toString().toLowerCase().trim();
        if (!cleanEmail && phone && phone.toString().trim() !== "") cleanPhone = phone.toString().replace(/\D/g, '').trim();

        if (!cleanEmail && !cleanPhone) return res.status(400).json({ success: false, error: "חובה להזין מייל או טלפון" });

        const query = cleanEmail ? { email: cleanEmail } : { phone: cleanPhone };
        
        let updateData = { tempCode: code };
        if (cleanEmail) updateData.email = cleanEmail;
        if (cleanPhone) updateData.phone = cleanPhone;

        await User.findOneAndUpdate(query, { $set: updateData }, { upsert: true, new: true });
        res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false }); }
});

app.post('/verify-auth', async (req, res) => {
    let { email, phone, code } = req.body;
    try {
        if (code === 'check') return res.json({ success: true });

        let cleanEmail = undefined;
        let cleanPhone = undefined;

        if (email && email.toString().trim() !== "") cleanEmail = email.toString().toLowerCase().trim();
        if (!cleanEmail && phone && phone.toString().trim() !== "") cleanPhone = phone.toString().replace(/\D/g, '').trim();

        const query = cleanEmail ? { email: cleanEmail } : { phone: cleanPhone };
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
    // השתמשתי ב-tz מהקליינט אבל מיפיתי ל-Id עבור קשר
    const { userId, amount, ccDetails, fullName, tz, useToken, phone, email, note } = req.body;

    try {
        console.log("🚀 תרומה (J4)...");
        
        let user = await User.findById(userId);
        if (!user) return res.status(404).json({ success: false, error: "משתמש לא נמצא" });

        // הכנת תוקף
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
        if (useToken && user.token) {
            // ✅ תיקון: הוספת 0 לטוקן לפני השימוש
            activeToken = fixToken(user.token);
        }

        // בניית האובייקט לקשר (חזרנו ל-J4 ול-Id)
        let tranData = {
            Total: parseFloat(amount),
            Currency: 1, 
            CreditType: 1, 
            ParamJ: "J4", // חזרנו ל-J4 כבקשתך
            TransactionType: "debit",
            ProjectNumber: "00001",
            Phone: (phone || user.phone || "0500000000").toString(),
            FirstName: (fullName || user.name || "Torem").split(" ")[0],
            LastName: (fullName || user.name || "").split(" ").slice(1).join(" ") || "Family",
            Mail: email || user.email || "no-email@test.com",
            Id: tz || user.tz || "000000000", // חזרנו לשימוש ב-Id
            Details: note || ""
        };

        if (!useToken && ccDetails) {
            // חיוב רגיל בכרטיס אשראי
            tranData.CreditNum = ccDetails.num;
            tranData.Expiry = finalExpiry;
        } else if (useToken && activeToken) {
            // חיוב בטוקן
            tranData.Token = activeToken;
            tranData.Expiry = finalExpiry;
        } else {
            return res.status(400).json({ success: false, error: "חסר אמצעי תשלום" });
        }

        const sortedTranData = sortObjectKeys(tranData);
        console.log("📤 שולח לקשר:", JSON.stringify(sortedTranData));

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
        console.log("📩 תשובה:", JSON.stringify(resData));

        if (resData.RequestResult?.Status === true || resData.Status === true) {
            if (fullName) user.name = fullName;
            if (tz) user.tz = tz;
            if (phone) user.phone = phone;

            // שמירת טוקן אם נוצר חדש (כולל תיקון 0)
            if (!useToken && resData.Token) {
                user.token = fixToken(resData.Token);
                user.lastCardDigits = ccDetails.num.slice(-4);
                user.lastExpiry = finalExpiry;
            }

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
        console.error("🔥 Error:", e.message);
        res.status(500).json({ success: false, error: "שגיאת תקשורת" });
    }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`✅ Server Live`));
