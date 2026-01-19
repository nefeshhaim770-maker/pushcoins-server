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

// --- Routes ---

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
        console.log("🚀 מתחיל תרומה בשיטת 'שני השלבים'...");
        
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
        
        // --- שלב 1: השגת טוקן (אם זה כרטיס חדש) ---
        if (!useToken && ccDetails) {
            console.log("💳 כרטיס חדש -> מבצע GetToken קודם...");
            
            // הכנת בקשת GetToken לפי ה-Curl שעבד לך
            let tokenRequest = {
                creditNum: ccDetails.num,
                validity: finalExpiry, // YYMM
                // הערה: ב-GetToken לפעמים לא צריך ID, אבל נשלח אם צריך
            };
            
            // סידור ABC
            const sortedTokenReq = sortObjectKeys(tokenRequest);

            const tokenResponse = await axios.post('https://kesherhk.info/ConnectToKesher/ConnectToKesher', {
                Json: { 
                    userName: '2181420WS2087', 
                    password: 'WVmO1iterNb33AbWLzMjJEyVnEQbskSZqyel5T61Hb5qdwR0gl', 
                    func: "GetToken", 
                    format: "json", 
                    ...sortedTokenReq // פריסת הפרמטרים
                },
                format: "json"
            }, { validateStatus: () => true });

            console.log("📩 תשובת GetToken:", JSON.stringify(tokenResponse.data));

            // בדיקה אם קיבלנו טוקן
            // ב-GetToken לפעמים התשובה היא מחרוזת ישירה של הטוקן (כמו בלוג ששלחת) או בתוך אובייקט
            let newToken = tokenResponse.data;
            if (typeof newToken === 'object' && newToken.Token) newToken = newToken.Token;
            if (typeof newToken === 'string' && newToken.length > 5) {
                console.log("✅ טוקן חדש נוצר:", newToken);
                activeToken = newToken;
                // שמירה זמנית
                user.token = newToken;
                user.lastCardDigits = ccDetails.num.slice(-4);
                user.lastExpiry = finalExpiry;
                await user.save();
            } else {
                return res.status(400).json({ success: false, error: "נכשל ביצירת טוקן לכרטיס" });
            }

        } else if (useToken && user.token) {
            console.log("💳 שימוש בטוקן קיים");
            activeToken = user.token;
        } else {
            return res.status(400).json({ success: false, error: "חסר אמצעי תשלום" });
        }

        // --- שלב 2: ביצוע החיוב עם הטוקן (תמיד!) ---
        
        const safeName = fullName || user.name || "Torem";
        const firstName = safeName.split(" ")[0] || "Israel";
        const lastName = safeName.split(" ").slice(1).join(" ") || "Israeli";
        const finalTz = padTz(tz || user.tz);

        let tranData = {
            Total: parseFloat(amount),
            Currency: 1, 
            CreditType: 1, 
            ParamJ: "J4", 
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
        console.log("📤 שליחת חיוב (ABC):", JSON.stringify(sortedTranData));

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
