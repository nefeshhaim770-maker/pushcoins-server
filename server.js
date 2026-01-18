const express = require('express');
const cors = require('cors');
const axios = require('axios');
const mongoose = require('mongoose');
const app = express();

app.use(express.json());
app.use(cors());

mongoose.connect('mongodb+srv://nefeshhaim770_db_user:DxNzxIrIaoji0gWm@cluster0.njggbyd.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0')
    .then(() => console.log('✅ Connected to MongoDB'))
    .catch(err => console.error(err));

const userSchema = new mongoose.Schema({
    email: { type: String, sparse: true },
    phone: { type: String, sparse: true },
    name: String,
    tz: String,
    totalDonated: { type: Number, default: 0 },
    token: { type: String, default: "" },
    lastCardDigits: String,
    lastExpiry: String, 
    tempCode: String,
    notes: [String] 
});
const User = mongoose.model('User', userSchema);

// ... (פונקציות update-code ו-verify-auth ללא שינוי)

app.post('/donate', async (req, res) => {
    const { userId, amount, ccDetails, fullName, tz, useToken, phone, email, note } = req.body;
    try {
        let user = await User.findById(userId);
        if (!user) return res.status(404).json({ error: "משתמש לא נמצא" });

        let tranData = {
            Total: parseFloat(amount), 
            Currency: 1, 
            CreditType: 10, 
            NumPayment: "12", 
            Phone: phone || user.phone || "0500000000",
            FirstName: (fullName || user.name || "שם").split(" ")[0],
            LastName: (fullName || user.name || "משפחה").split(" ").slice(1).join(" ") || "משפחה",
            Mail: email || user.email || "no-email@test.com", 
            ParamJ: "J4", 
            TransactionType: "debit",
            ProjectNumber: "00001",
            // שדה החובה החדש לפי התיעוד ששלחת
            customerRef: user._id.toString() 
        };

        if (useToken && user.token) {
            console.log("💳 שימוש בטוקן שמור:", user.token);
            tranData.Token = user.token;
            // חובה לשלוח תוקף גם עם טוקן בעסקאות תשלומים
            if (user.lastExpiry) tranData.Expiry = user.lastExpiry;
        } else if (ccDetails) {
            tranData.CreditNum = ccDetails.num; 
            tranData.Expiry = ccDetails.exp; 
            tranData.Cvv2 = ccDetails.cvv;
        }

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
        console.log("📩 Kesher Response:", JSON.stringify(resData));

        if (resData.RequestResult?.Status === true || resData.Status === true) {
            user.totalDonated += parseFloat(amount);
            
            const rToken = resData.Token || resData.RequestResult?.Token;
            if (rToken) {
                user.token = rToken;
                if (!useToken && ccDetails) {
                    user.lastCardDigits = ccDetails.num.slice(-4);
                    user.lastExpiry = ccDetails.exp;
                }
            }
            await user.save();
            res.json({ success: true, user });
        } else { 
            res.status(400).json({ success: false, error: resData.RequestResult?.Description || "נדחה" }); 
        }
    } catch (e) { res.status(500).json({ success: false, error: "שגיאת שרת" }); }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`✅ Server Live`));
