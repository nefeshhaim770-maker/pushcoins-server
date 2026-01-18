const express = require('express');
const cors = require('cors');
const axios = require('axios');
const mongoose = require('mongoose');
const app = express();

app.use(express.json());
app.use(cors());

const MONGO_URI = 'mongodb+srv://nefeshhaim770_db_user:DxNzxIrIaoji0gWm@cluster0.njggbyd.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0';

mongoose.connect(MONGO_URI)
    .then(() => console.log('✅ Connected to MongoDB Atlas'))
    .catch(err => console.error('❌ MongoDB Connection Error:', err));

const userSchema = new mongoose.Schema({
    phone: { type: String, unique: true, required: true },
    name: { type: String, default: "" },
    email: { type: String, default: "" },
    totalDonated: { type: Number, default: 0 },
    lastCardDigits: { type: String, default: "" }, 
    lastCardExp: { type: String, default: "" }
});
const User = mongoose.model('User', userSchema);

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
        if (!user) {
            user = new User({ phone });
            await user.save();
        }
        res.json({ success: true, user });
    } catch (e) {
        const fakeUser = { phone, name: "", totalDonated: 0 };
        res.json({ success: true, user: fakeUser }); 
    }
});

app.post('/donate', async (req, res) => {
    // הוספנו כאן את fullName
    const { phone, amount, ccDetails, email, fullName } = req.body;
    
    try {
        const totalAgorot = parseInt(amount) * 100;
        let finalExpiry = ccDetails.exp;
        if (finalExpiry.length === 4) finalExpiry = finalExpiry.substring(2,4) + finalExpiry.substring(0,2);
        
        const payload = {
            Json: {
                userName: KESHER_USER, password: KESHER_PASS, func: "SendTransaction", format: "json",
                tran: {
                    CreditNum: ccDetails.num, Expiry: finalExpiry, Total: totalAgorot, Cvv2: ccDetails.cvv,
                    Currency: 1, CreditType: 1, Phone: phone, ParamJ: "J4", TransactionType: "debit",
                    Mail: email || "app@donate.com",
                    // כאן התיקון: משתמשים בשם שנשלח מהטופס
                    FirstName: fullName || "Torem", LastName: "." 
                }
            }, format: "json"
        };
        
        const response = await axios.post(KESHER_URL, payload);
        
        if (response.data.RequestResult?.Status === true) {
            try {
                let user = await User.findOne({ phone });
                if(user) {
                    user.totalDonated += parseInt(amount);
                    // שומרים את השם והמייל לפעם הבאה
                    if (fullName) user.name = fullName;
                    if (email) user.email = email;
                    await user.save();
                }
            } catch(e) {}
            
            res.json({ success: true, newTotal: (user ? user.totalDonated : 0) });
        } else {
            res.status(400).json({ success: false, error: "נדחה" });
        }
    } catch (e) { res.status(500).json({ success: false, error: "שגיאה" }); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
