const express = require('express');
const cors = require('cors');
const axios = require('axios');
const mongoose = require('mongoose');
const app = express();

app.use(express.json());
app.use(cors());

// --- חיבור למסד נתונים ---
const MONGO_URI = 'mongodb+srv://nefeshhaim770_db_user:DxNzxIrIaoji0gWm@cluster0.njggbyd.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0';

mongoose.connect(MONGO_URI)
    .then(() => console.log('✅ Connected to MongoDB Atlas'))
    .catch(err => console.error('❌ MongoDB Connection Error:', err));

// --- מודל משתמש (כולל מקום לטוקן ות"ז) ---
const userSchema = new mongoose.Schema({
    phone: { type: String, unique: true, required: true },
    name: { type: String, default: "" },
    email: { type: String, default: "" },
    tz: { type: String, default: "" },
    totalDonated: { type: Number, default: 0 },
    token: { type: String, default: "" }, // כאן נשמור את הטוקן לחיוב חוזר
    lastCardDigits: { type: String, default: "" }, 
    lastCardExp: { type: String, default: "" }
});
const User = mongoose.model('User', userSchema);

// --- פרטי קשר (Kesher) ---
const KESHER_URL = 'https://kesherhk.info/ConnectToKesher/ConnectToKesher';
const KESHER_USER = '2181420WS2087';
const KESHER_PASS = 'WVmO1iterNb33AbWLzMjJEyVnEQbskSZqyel5T61Hb5qdwR0gl';

app.get('/', (req, res) => res.send('PushCoins Server Live!'));

app.post('/send-auth', (req, res) => { res.json({ success: true }); });

app.post('/verify-auth', async (req, res) => {
    const { phone, code } = req.body;
    if (code !== '1234') return res.json({ success: false, error: "קוד שגוי" });
    try {
        let user = await User.findOne({ phone });
        if (!user) { user = new User({ phone }); await user.save(); }
        res.json({ success: true, user });
    } catch (e) { res.json({ success: true, user: { phone, name: "", totalDonated: 0 } }); }
});

// --- פונקציית התרומה המעודכנת ---
app.post('/donate', async (req, res) => {
    const { phone, amount, ccDetails, email, fullName, tz } = req.body;
    
    try {
        console.log(`Starting donation: ${amount} ILS for ${fullName} (TZ: ${tz})`);

        const totalAgorot = parseInt(amount) * 100; // המרה לאגורות
        
        // סידור התוקף (MMYY)
        let finalExpiry = ccDetails.exp;
        if (finalExpiry.length === 4) {
            // אם המשתמש הכניס 0426, נהפוך את זה ל-2604 אם צריך, או נשאיר ככה
            // בדוגמה שלך כתוב Expiry: "2512" (שנה-חודש או חודש-שנה? בדרך כלל זה MMYY)
            // נשאיר את זה כמו שהמשתמש מכניס כרגע.
        }

        // פיצול שם
        const cleanName = (fullName || "Torem").trim();
        const nameParts = cleanName.split(" ");
        const firstName = nameParts[0];
        const lastName = nameParts.length > 1 ? nameParts.slice(1).join(" ") : "Ben";

        // בניית הבקשה בדיוק לפי ה-JSON ששלחת
        const payload = {
            Json: {
                userName: KESHER_USER,
                password: KESHER_PASS,
                func: "SendTransaction",
                format: "json",
                tran: {
                    CreditNum: ccDetails.num,
                    Expiry: finalExpiry,
                    Total: totalAgorot,
                    Cvv2: ccDetails.cvv,
                    Currency: 1, // שקלים
                    CreditType: 1, // רגיל (לא תשלומים)
                    Phone: phone,
                    ParamJ: "J4",
                    TransactionType: "debit",
                    FirstName: firstName,
                    LastName: lastName,
                    Mail: email || "app@donate.com",
                    TZ: tz || "", // הוספנו את זה ידנית, נקווה שזה יעבוד
                    DynamicFields: [
                         { "FieldReference": "AppDonation", "value": "True" } // שדה לדוגמה
                    ]
                }
            },
            format: "json"
        };

        const response = await axios.post(KESHER_URL, payload);
        
        // --- הדפסת התשובה כדי למצוא את הטוקן ---
        console.log("--------------- KESHER RESPONSE ---------------");
        console.log(JSON.stringify(response.data)); 
        console.log("-----------------------------------------------");

        if (response.data.RequestResult && response.data.RequestResult.Status === true) {
            // שמירת נתונים
            try {
                let user = await User.findOne({ phone });
                if(user) {
                    user.totalDonated += parseInt(amount);
                    if (fullName) user.name = fullName;
                    if (email) user.email = email;
                    if (tz) user.tz = tz;
                    user.lastCardDigits = ccDetails.num.slice(-4);
                    
                    // כאן נשמור את הטוקן אחרי שנראה איך הוא מגיע ב-Log
                    // user.token = response.data.RequestResult.Token; 
                    
                    await user.save();
                }
            } catch(e) {}
            
            res.json({ success: true, newTotal: (parseInt(amount)) });
        } else {
            const errMsg = response.data.RequestResult?.Description || "העסקה נדחתה";
            console.log("Transaction Failed:", errMsg);
            res.status(400).json({ success: false, error: errMsg });
        }

    } catch (e) { 
        console.error("System Error:", e);
        res.status(500).json({ success: false, error: "שגיאת שרת" }); 
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
