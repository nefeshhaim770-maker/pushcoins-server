const express = require('express');
const cors = require('cors');
const axios = require('axios');
const mongoose = require('mongoose');
const nodemailer = require('nodemailer'); 
const app = express();

app.use(express.json());
app.use(cors());

// ============================================================
// ⚙️ הגדרות המייל - ניסיון חיבור חזק (465 + IPv4 + Debug)
// ============================================================
const transporter = nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 465,              // חוזרים לפורט המאובטח (לרוב עובד טוב יותר עם IPv4)
    secure: true,           // חובה בפורט 465
    auth: {
        user: process.env.EMAIL_USER, 
        pass: process.env.EMAIL_PASS  
    },
    tls: {
        rejectUnauthorized: false
    },
    family: 4,              // מכריח שימוש ב-IPv4 (מונע ניתוקים)
    debug: true,            // ידפיס לוגים מפורטים של התקשורת
    logger: true            // ידפיס לוגים מפורטים של התקשורת
});

// בדיקה שהמייל מחובר תקין
transporter.verify((error, success) => {
    if (error) {
        console.error("❌ שגיאה בחיבור לשרת המיילים:", error);
    } else {
        console.log("✅ השרת מחובר לג'ימייל (465+IPv4) ומוכן לשליחה!");
    }
});
// ============================================================

mongoose.connect('mongodb+srv://nefeshhaim770_db_user:DxNzxIrIaoji0gWm@cluster0.njggbyd.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0')
    .then(async () => {
        console.log('✅ MongoDB Connected');
        try { await mongoose.connection.db.collection('users').dropIndex('phone_1'); } catch (e) { }
        try { await mongoose.connection.db.collection('users').dropIndex('email_1'); } catch (e) { }
    })
    .catch(err => console.error('❌ MongoDB Error:', err));

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
        note: String,
        status: { type: String, default: 'success' }, 
        failReason: String,
        cardDigits: String
    }],
    tempCode: String
});
const User = mongoose.model('User', userSchema);

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
        let cleanEmail = undefined;
        let cleanPhone = undefined;

        if (email && email.toString().trim() !== "") cleanEmail = email.toString().toLowerCase().trim();
        if (!cleanEmail && phone && phone.toString().trim() !== "") cleanPhone = phone.toString().replace(/\D/g, '').trim();

        if (!cleanEmail && !cleanPhone) return res.status(400).json({ success: false, error: "חובה להזין מייל או טלפון" });

        const query = cleanEmail ? { email: cleanEmail } : { phone: cleanPhone };
        
        let updateData = { tempCode: code };
        if (cleanEmail) updateData.email = cleanEmail;
        if (cleanPhone) updateData.phone = cleanPhone;

        await User.findOneAndUpdate(query, { $set: updateData }, { upsert: true, new: true });

        // --- שליחת המייל ---
        if (cleanEmail) {
            const mailOptions = {
                from: '"קופת צדקה" <' + process.env.EMAIL_USER + '>',
                to: cleanEmail,
                subject: 'קוד אימות לכניסה',
                html: `
                    <div style="direction:rtl; text-align:center; font-family:Arial,sans-serif;">
                        <h2>קוד הכניסה שלך הוא:</h2>
                        <h1 style="color:#27ae60; font-size:40px; letter-spacing:5px;">${code}</h1>
                        <p>הקוד תקף לזמן מוגבל.</p>
                    </div>
                `
            };

            try {
                await transporter.sendMail(mailOptions);
                console.log("📧 המייל נשלח בהצלחה ל-" + cleanEmail);
                res.json({ success: true });
            } catch (mailError) {
                console.error("❌ שגיאה בשליחת המייל (ראה פירוט למעלה):", mailError);
                res.status(500).json({ success: false, error: "תקלה בשליחת המייל" });
            }
        } else {
            console.log("SMS Code (Mock): " + code);
            res.json({ success: true });
        }

    } catch (e) { 
        console.error("General Error:", e);
        res.status(500).json({ success: false, error: "שגיאת שרת כללית" }); 
    }
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

        if (user && String(user.tempCode).trim() === String(code).trim()) {
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
    const { userId, name, email, phone, tz } = req.body;
    try {
        let updateData = { name, tz };
        if (email) updateData.email = email.toString().toLowerCase().trim();
        if (phone) updateData.phone = phone.toString().replace(/\D/g, '').trim();
        
        let user = await User.findByIdAndUpdate(userId, updateData, { new: true });
        res.json({ success: true, user });
    } catch (e) { res.status(500).json({ success: false }); }
});

app.post('/donate', async (req, res) => {
    const { userId, amount, ccDetails, fullName, tz, useToken, phone, email, note } = req.body;

    try {
        console.log("🚀 תרומה מתחילה...");
        
        let user = await User.findById(userId);
        if (!user) return res.status(404).json({ success: false, error: "משתמש לא נמצא" });

        let finalExpiry = "";
        let currentCardDigits = user.lastCardDigits || "????";
        
        if (ccDetails && ccDetails.exp) {
            if (ccDetails.exp.length === 4) {
                finalExpiry = ccDetails.exp.substring(2, 4) + ccDetails.exp.substring(0, 2);
            } else {
                finalExpiry = ccDetails.exp;
            }
            currentCardDigits = ccDetails.num.slice(-4); 
        } else if (useToken) {
            finalExpiry = user.lastExpiry; 
            currentCardDigits = user.lastCardDigits;
        }

        let activeToken = "";
        if (useToken && user.token) {
            activeToken = fixToken(user.token);
        }

        const amountInAgorot = Math.round(parseFloat(amount) * 100);

        const rawId = tz || user.tz || "000000000";
        const realIdToSend = rawId.replace(/\D/g, ''); 
        
        const safePhone = (phone || user.phone || "0500000000").replace(/\D/g, '');

        let tranData = {
            Total: amountInAgorot,
            Currency: 1, 
            CreditType: 1, 
            ParamJ: "J4", 
            TransactionType: "debit",
            ProjectNumber: "00001",
            Phone: safePhone,
            FirstName: (fullName || user.name || "Torem").split(" ")[0],
            LastName: (fullName || user.name || "").split(" ").slice(1).join(" ") || "Family",
            Mail: email || user.email || "no-email@test.com",
            ClientApiIdentity: realIdToSend,
            Id: realIdToSend,
            Details: note || ""
        };

        if (!useToken && ccDetails) {
            tranData.CreditNum = ccDetails.num;
            tranData.Expiry = finalExpiry;
        } else if (useToken && activeToken) {
            tranData.Token = activeToken;
            tranData.Expiry = finalExpiry;
        } else {
            return res.status(400).json({ success: false, error: "חסר אמצעי תשלום" });
        }

        const sortedTranData = sortObjectKeys(tranData);
        
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

        if (isSuccess) {
            if (fullName) user.name = fullName;
            if (tz) user.tz = tz;
            if (phone) user.phone = phone;

            if (!useToken && resData.Token) {
                user.token = fixToken(resData.Token);
                user.lastCardDigits = ccDetails.num.slice(-4);
                user.lastExpiry = finalExpiry;
            }

            user.totalDonated += parseFloat(amount);
            
            user.donationsHistory.push({ 
                amount: parseFloat(amount), 
                note: note || "", 
                date: new Date(),
                status: 'success',
                cardDigits: currentCardDigits
            });
            
            await user.save();
            res.json({ success: true, user });
        } else {
            const errorMsg = resData.RequestResult?.Description || resData.Description || "סירוב עסקה";
            
            if (errorMsg.includes("טוקן") || errorMsg.includes("Token")) {
                user.token = ""; 
                await user.save();
            }
            
            user.donationsHistory.push({ 
                amount: parseFloat(amount), 
                note: note || "", 
                date: new Date(),
                status: 'failed',
                failReason: errorMsg,
                cardDigits: currentCardDigits
            });
            await user.save();

            res.status(400).json({ success: false, error: errorMsg });
        }

    } catch (e) {
        console.error("🔥 Error:", e.message);
        res.status(500).json({ success: false, error: "שגיאת תקשורת" });
    }
});

// --- ADMIN ---
const ADMIN_PASSWORD = "admin1234";

app.post('/admin/login', (req, res) => {
    const { password } = req.body;
    if (password === ADMIN_PASSWORD) res.json({ success: true });
    else res.json({ success: false, error: "סיסמה שגויה" });
});

app.post('/admin/get-users', async (req, res) => {
    const { password } = req.body;
    if (password !== ADMIN_PASSWORD) return res.status(403).json({ success: false });
    try {
        const users = await User.find().sort({ totalDonated: -1 });
        res.json({ success: true, users });
    } catch (e) { res.status(500).json({ success: false }); }
});

app.post('/admin/delete-user', async (req, res) => {
    const { password, userId } = req.body;
    if (password !== ADMIN_PASSWORD) return res.status(403).json({ success: false });
    try {
        await User.findByIdAndDelete(userId);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false }); }
});

app.post('/admin/update-user', async (req, res) => {
    const { password, userId, name, email, phone, tz, token } = req.body;
    if (password !== ADMIN_PASSWORD) return res.status(403).json({ success: false });

    try {
        let updateData = { name, tz, token };
        if (email) updateData.email = email.toString().toLowerCase().trim();
        if (phone) updateData.phone = phone.toString().replace(/\D/g, '').trim();
        
        await User.findByIdAndUpdate(userId, updateData);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false, error: "שגיאה בעדכון" }); }
});

app.post('/admin/recalc-totals', async (req, res) => {
    const { password } = req.body;
    if (password !== ADMIN_PASSWORD) return res.status(403).json({ success: false });

    try {
        const users = await User.find();
        let totalUpdated = 0;

        for (const user of users) {
            let correctTotal = 0;
            if (user.donationsHistory && user.donationsHistory.length > 0) {
                user.donationsHistory.forEach(d => {
                    const isFailed = d.status === 'failed' || (d.failReason && d.failReason.includes('חסום'));
                    if (!isFailed) {
                        correctTotal += (d.amount || 0);
                    }
                });
            }
            user.totalDonated = correctTotal;
            await user.save();
            totalUpdated++;
        }
        res.json({ success: true, count: totalUpdated });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`✅ Server Live`));
