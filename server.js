const express = require('express');
const cors = require('cors');
const axios = require('axios');
const mongoose = require('mongoose');
const admin = require('firebase-admin');
const cron = require('node-cron');
const path = require('path');
const nodemailer = require('nodemailer'); 
const app = express();

// Increase payload limit for file uploads (Base64)
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '10mb', extended: true }));
app.use(cors());

// --- Email Configuration (Nodemailer) ---
// שימוש בפורט 587 (TLS) שהוא לפעמים פחות חסום מ-465
const transporter = nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 587, 
    secure: false, 
    auth: {
        user: 'ceo1@nefesh-ha-chaim.org',
        pass: 'czxz xuvt hica dzlz'
    },
    tls: {
        rejectUnauthorized: false
    },
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 10000
});

async function sendEmail(to, subject, text) {
    try {
        console.log(`⏳ Attempting to send email to ${to}...`);
        await transporter.sendMail({
            from: '"נפש החיים" <ceo1@nefesh-ha-chaim.org>',
            to: to,
            subject: subject,
            text: text,
            html: `<div style="direction: rtl; text-align: right; font-family: Arial, sans-serif;">${text}</div>`
        });
        console.log(`✅ Email sent successfully to ${to}`);
        return true;
    } catch (error) {
        console.error("❌ Email Error Details:", error);
        return false;
    }
}

// --- Firebase ---
try {
    const serviceAccount = require('/etc/secrets/serviceAccountKey.json'); 
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
} catch (e) {
    try {
        const serviceAccount = require('./serviceAccountKey.json');
        admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
    } catch (err) { console.log("⚠️ No Firebase Key"); }
}

// --- MongoDB ---
mongoose.connect('mongodb+srv://nefeshhaim770_db_user:DxNzxIrIaoji0gWm@cluster0.njggbyd.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0')
    .then(() => console.log('✅ DB Connected'))
    .catch(err => console.error('❌ DB Error:', err));

// --- Schema ---
const cardSchema = new mongoose.Schema({
    token: String,
    lastDigits: String,
    expiry: String,
    active: { type: Boolean, default: false },
    addedDate: { type: Date, default: Date.now }
});

const messageSchema = new mongoose.Schema({
    direction: String, 
    content: String,
    attachment: String, 
    attachmentName: String,
    date: { type: Date, default: Date.now },
    read: { type: Boolean, default: false }
});

// BANK AUTH SCHEMA
const bankAuthSchema = new mongoose.Schema({
    status: { type: String, default: 'none' }, // none, pending, active, rejected
    bankName: String,
    branch: String,
    account: String,
    ownerName: String,
    phone: String,
    signature: String, // Base64 signature image
    file: String, // Base64 uploaded file
    token: String, // The token from Kesher provided by Admin
    dailyLimit: { type: Number, default: 0 },
    validUntil: Date,
    requestDate: { type: Date, default: Date.now }
});

const userSchema = new mongoose.Schema({
    email: { type: String, sparse: true },
    phone: { type: String, sparse: true },
    name: String,
    tz: String,
    
    // Receipt Fields
    receiptName: { type: String, default: "" },
    receiptTZ: { type: String, default: "" },
    receiptMode: { type: Number, default: 0 }, 
    
    // Maaser Fields
    maaserActive: { type: Boolean, default: false },
    maaserRate: { type: Number, default: 10 },
    maaserIncome: { type: Number, default: 0 },

    // Tax Widget
    showTaxWidget: { type: Boolean, default: true },

    // Messages
    messages: [messageSchema],
    
    // Bank Authorization
    bankAuth: { type: bankAuthSchema, default: {} },

    lastExpiry: String,
    lastCardDigits: String,
    token: { type: String, default: "" },
    cards: [cardSchema],
    totalDonated: { type: Number, default: 0 },
    billingPreference: { type: Number, default: 0 }, 
    recurringDailyAmount: { type: Number, default: 0 },
    recurringImmediate: { type: Boolean, default: false },
    canRemoveFromBasket: { type: Boolean, default: true },
    securityPin: { type: String, default: "" },
    fcmToken: { type: String, default: "" },
    donationsHistory: [{ 
        amount: Number, 
        date: { type: Date, default: Date.now }, 
        note: String, 
        status: String, 
        failReason: String, 
        isGoal: { type: Boolean, default: false }, 
        receiptNameUsed: String,
        receiptTZUsed: String,
        receiptUrl: String 
    }],
    pendingDonations: [{ amount: Number, date: { type: Date, default: Date.now }, note: String }],
    tempCode: String
});
// אינדקסים לשיפור ביצועים
userSchema.index({ phone: 1 });
userSchema.index({ email: 1 });

const User = mongoose.model('User', userSchema);

// --- NEW GOAL SCHEMA ---
const goalSchema = new mongoose.Schema({
    id: { type: String, default: 'main_goal' }, 
    title: String,
    targetAmount: Number,
    currentAmount: { type: Number, default: 0 },
    isActive: { type: Boolean, default: false },
    description: String
});
const GlobalGoal = mongoose.model('GlobalGoal', goalSchema);

// --- Helpers ---
function sortObjectKeys(obj) { 
    return Object.keys(obj).sort().reduce((r, k) => { 
        r[k] = obj[k]; 
        return r; 
    }, {}); 
}

function fixToken(token) {
    if (!token) return "";
    let strToken = String(token).replace(/['"]+/g, '').trim();
    return (strToken.length > 0 && !strToken.startsWith('0')) ? '0' + strToken : strToken;
}

async function getActiveToken(user) {
    // 1. Check for Active Bank Auth first (Priority if Active)
    if (user.bankAuth && user.bankAuth.status === 'active' && user.bankAuth.token) {
        // Check Expiry
        if (!user.bankAuth.validUntil || new Date(user.bankAuth.validUntil) > new Date()) {
             return { type: 'bank', token: user.bankAuth.token };
        }
    }
    // 2. Fallback to Credit Card
    if (user.cards && user.cards.length > 0) {
        const activeCard = user.cards.find(c => c.active);
        return { type: 'cc', token: activeCard ? activeCard.token : user.cards[0].token };
    }
    if (user.token) {
        user.cards.push({ token: user.token, lastDigits: user.lastCardDigits || "****", expiry: user.lastExpiry || "", active: true });
        user.token = ""; 
        await user.save();
        return { type: 'cc', token: fixToken(user.cards[0].token) };
    }
    return null;
}

// --- Charge Engine ---
async function chargeKesher(user, amount, note, creditDetails = null, useReceiptDetails = false) {
    const amountInAgorot = Math.round(parseFloat(amount) * 100);
    const safePhone = (user.phone || "0500000000").replace(/\D/g, '');
    
    let finalName = user.name || "Torem";
    let finalID = user.tz;

    if (useReceiptDetails && user.receiptName && user.receiptTZ) {
        finalName = user.receiptName;
        finalID = user.receiptTZ;
    }

    let uniqueId = finalID && finalID.length > 5 ? finalID : null;
    if (!uniqueId) uniqueId = safePhone !== "0500000000" ? safePhone : user._id.toString();

    const nameParts = finalName.trim().split(" ");
    const firstName = nameParts[0];
    let lastName = nameParts.length > 1 ? nameParts.slice(1).join(" ") : "";
    if (!lastName) lastName = " "; 

    let tranData = {
        Total: amountInAgorot, Currency: 1, CreditType: 1, ParamJ: "J4", TransactionType: "debit", 
        ProjectNumber: "00001", Phone: safePhone, FirstName: firstName, LastName: lastName, 
        Mail: user.email || "no@mail.com", ClientApiIdentity: uniqueId, Id: uniqueId, Details: note || ""
    };

    let finalExpiry = "";
    let currentCardDigits = "";
    
    // Check payment method
    if (creditDetails) {
        tranData.CreditNum = creditDetails.num;
        if (creditDetails.exp.length === 4) { finalExpiry = creditDetails.exp.substring(2, 4) + creditDetails.exp.substring(0, 2); } else { finalExpiry = creditDetails.exp; }
        tranData.Expiry = finalExpiry;
        currentCardDigits = creditDetails.num.slice(-4);
    } else {
        const method = await getActiveToken(user);
        if (method) {
            tranData.Token = fixToken(method.token);
            
            // Check Bank Limits
            if (method.type === 'bank') {
                if (user.bankAuth.dailyLimit > 0 && parseFloat(amount) > user.bankAuth.dailyLimit) {
                    throw new Error(`חריגה מתקרת הוראת קבע בנקאית (מקסימום ${user.bankAuth.dailyLimit})`);
                }
                currentCardDigits = "Bank"; 
            } else {
                // CC
                const activeCard = user.cards.find(c => fixToken(c.token) === tranData.Token);
                if(activeCard) { 
                    tranData.Expiry = activeCard.expiry; 
                    currentCardDigits = activeCard.lastDigits; 
                    finalExpiry = activeCard.expiry; 
                }
            }
        } else { throw new Error("No Payment Method"); }
    }

    const sortedTran = sortObjectKeys(tranData);
    console.log(`🚀 Sending Transaction for ${user.name}:`, JSON.stringify(sortedTran));

    const res = await axios.post('https://kesherhk.info/ConnectToKesher/ConnectToKesher', {
        Json: { userName: '2181420WS2087', password: 'WVmO1iterNb33AbWLzMjJEyVnEQbskSZqyel5T61Hb5qdwR0gl', func: "SendTransaction", format: "json", tran: sortedTran },
        format: "json"
    }, { validateStatus: () => true });

    console.log(`📩 Response for ${user.name}:`, JSON.stringify(res.data));

    const receiptUrl = res.data.FileUrl || res.data.InvoiceUrl || null;

    return { 
        success: res.data.RequestResult?.Status === true || res.data.Status === true, 
        data: res.data, 
        token: res.data.Token, 
        finalExpiry, 
        currentCardDigits,
        receiptNameUsed: finalName,
        receiptTZUsed: finalID,
        receiptUrl: receiptUrl
    };
}

// --- Cron Job ---
cron.schedule('0 8 * * *', async () => {
    const today = new Date().getDate(); 
    console.log(`⏳ Starting Daily Cron. Day: ${today}`); 

    const users = await User.find({}); 
    for (const u of users) {
        let saveUser = false;
        // Check Payment Availability
        const paymentMethod = await getActiveToken(u);
        const hasToken = !!paymentMethod;
        const useReceipt = (u.receiptMode === 1 && u.receiptName && u.receiptTZ);

        if (u.recurringDailyAmount > 0) {
            if (u.recurringImmediate === true || u.billingPreference === 0) {
                if(hasToken) {
                    try {
                        const r = await chargeKesher(u, u.recurringDailyAmount, "הוראת קבע יומית", null, useReceipt);
                        
                        if (r.success) {
                            u.totalDonated += u.recurringDailyAmount;
                            u.donationsHistory.push({ 
                                amount: u.recurringDailyAmount, 
                                note: "יומי קבוע (מיידי)", 
                                status: "success", 
                                receiptNameUsed: r.receiptNameUsed,
                                receiptTZUsed: r.receiptTZUsed,
                                receiptUrl: r.receiptUrl
                            });
                        } else {
                            const failReason = r.data.Description || r.data.errDesc || "תקלה בסליקה";
                            u.donationsHistory.push({ 
                                amount: u.recurringDailyAmount, 
                                note: "יומי קבוע", 
                                status: "failed", 
                                failReason: failReason 
                            });
                        }
                    } catch(e) {
                        u.donationsHistory.push({ amount: u.recurringDailyAmount, note: "יומי קבוע", status: "failed", failReason: e.message });
                    }
                    saveUser = true;
                }
            } else {
                u.pendingDonations.push({ amount: u.recurringDailyAmount, note: "יומי קבוע (הצטברות)" });
                saveUser = true;
            }
        }

        const prefDay = parseInt(u.billingPreference);
        const currentDay = parseInt(today);
        const isChargeDay = (prefDay === currentDay) || (prefDay === 0);

        if ((isChargeDay || isImmediateUser) && u.pendingDonations.length > 0) {
            let totalToCharge = 0;
            u.pendingDonations.forEach(d => totalToCharge += d.amount);
            
            if (totalToCharge > 0 && hasToken) {
                try {
                    console.log(`Charging basket for user ${u.name} (Amount: ${totalToCharge})`);
                    const r = await chargeKesher(u, totalToCharge, "חיוב סל ממתין", null, useReceipt);
                    
                    if (r.success) {
                        u.totalDonated += totalToCharge;
                        u.pendingDonations.forEach(d => { 
                            u.donationsHistory.push({ 
                                amount: d.amount, 
                                note: d.note, 
                                status: "success", 
                                date: new Date(), 
                                receiptNameUsed: r.receiptNameUsed,
                                receiptTZUsed: r.receiptTZUsed,
                                receiptUrl: r.receiptUrl
                            }); 
                        });
                        u.pendingDonations = []; 
                    } else {
                        console.log(`Basket charge failed: ${r.data.Description}`);
                    }
                } catch (e) {
                    console.log(`Basket charge failed for ${u.name}: ${e.message}`);
                }
                saveUser = true;
            }
        }
        if (saveUser) await u.save();
    }
    console.log('✅ Cron Finished');
});

// --- Routes ---
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/manager', (req, res) => res.sendFile(path.join(__dirname, 'admin.html')));
app.get('/firebase-messaging-sw.js', (req, res) => res.sendFile(path.join(__dirname, 'firebase-messaging-sw.js')));

// --- CONTACT / MESSAGE ROUTES ---
app.post('/contact/send', async (req, res) => {
    const { userId, content, attachment, attachmentName } = req.body;
    try {
        const u = await User.findById(userId);
        if(!u) return res.json({ success: false, error: 'User not found' });
        
        u.messages.push({
            direction: 'user_to_admin',
            content,
            attachment, 
            attachmentName,
            read: false,
            date: new Date()
        });
        await u.save();
        
        await sendEmail('ceo1@nefesh-ha-chaim.org', 'הודעה חדשה באפליקציה', `המשתמש ${u.name} שלח הודעה.`);
        res.json({ success: true });
    } catch(e) { res.json({ success: false, error: e.message }); }
});

app.post('/admin/reply', async (req, res) => {
    if(req.body.password !== "admin1234") return res.json({ success: false });
    const { userId, content, attachment, attachmentName } = req.body;
    try {
        const u = await User.findById(userId);
        if(!u) return res.json({ success: false, error: 'User not found' });

        u.messages.push({
            direction: 'admin_to_user',
            content,
            attachment,
            attachmentName,
            read: false,
            date: new Date()
        });
        await u.save();
        
        if(u.fcmToken) {
            try {
                await admin.messaging().send({
                    token: u.fcmToken,
                    notification: {
                        title: 'הודעה חדשה מההנהלה',
                        body: content || 'התקבל קובץ חדש'
                    }
                });
            } catch(e) {}
        }
        res.json({ success: true });
    } catch(e) { res.json({ success: false, error: e.message }); }
});

// ✅ אופטימיזציה: שליפת משתמשים לאדמין ללא תוכן ההודעות והקבצים הכבדים
app.post('/admin/get-messages', async (req, res) => {
    if(req.body.password !== "admin1234") return res.json({ success: false });
    
    const users = await User.find({ 'messages.0': { $exists: true } })
        .select('name phone messages.date messages.direction messages.read _id')
        .lean();
    
    const sortedUsers = users.map(u => {
        const lastMsg = u.messages[u.messages.length - 1];
        const unreadCount = u.messages.filter(m => m.direction === 'user_to_admin' && !m.read).length;
        return {
            _id: u._id,
            name: u.name,
            phone: u.phone,
            lastMessageDate: lastMsg ? lastMsg.date : 0,
            unreadCount
        };
    }).sort((a,b) => new Date(b.lastMessageDate) - new Date(a.lastMessageDate));

    res.json({ success: true, users: sortedUsers });
});

// ✅ שליפת תוכן הצ'אט המלא
app.post('/admin/get-chat-content', async (req, res) => {
    if(req.body.password !== "admin1234") return res.json({ success: false });
    const { userId } = req.body;
    const u = await User.findById(userId).select('messages');
    if(u) res.json({ success: true, messages: u.messages });
    else res.json({ success: false });
});

// ✅ שליפת תוכן הצ'אט עבור הלקוח
app.post('/contact/get-my-messages', async (req, res) => {
    const { userId } = req.body;
    const u = await User.findById(userId).select('messages');
    if(u) res.json({ success: true, messages: u.messages });
    else res.json({ success: false });
});

app.post('/admin/mark-read', async (req, res) => {
    if(req.body.password !== "admin1234") return res.json({ success: false });
    const { userId } = req.body;
    await User.updateOne(
        { _id: userId },
        { $set: { "messages.$[elem].read": true } },
        { arrayFilters: [{ "elem.direction": "user_to_admin" }] }
    );
    res.json({ success: true });
});

app.post('/user/mark-read', async (req, res) => {
    const { userId } = req.body;
    await User.updateOne(
        { _id: userId },
        { $set: { "messages.$[elem].read": true } },
        { arrayFilters: [{ "elem.direction": "admin_to_user" }] }
    );
    res.json({ success: true });
});

// --- AUTH & USER ROUTES ---

app.post('/update-code', async (req, res) => {
    let { email, phone, code } = req.body;
    let cleanEmail = email ? email.toLowerCase().trim() : undefined;
    let cleanPhone = phone ? phone.replace(/\D/g, '').trim() : undefined;
    
    if (cleanEmail) { 
        await sendEmail(cleanEmail, 'קוד אימות - נפש החיים', `<h1>קוד האימות שלך: ${code}</h1>`);
    }
    
    await User.findOneAndUpdate(
        cleanEmail ? { email: cleanEmail } : { phone: cleanPhone }, 
        { tempCode: code, email: cleanEmail, phone: cleanPhone }, 
        { upsert: true }
    );
    res.json({ success: true });
});

app.post('/send-verification', async (req, res) => {
    const { email, code } = req.body;
    const sent = await sendEmail(email, 'אימות מייל', `קוד לאימות המייל: ${code}`);
    res.json({ success: sent });
});

app.post('/verify-auth', async (req, res) => {
    let { email, phone, code } = req.body;
    if(code === 'check') return res.json({ success: true });
    
    let u = await User.findOne(email ? { email: email.toLowerCase().trim() } : { phone: phone.replace(/\D/g, '').trim() });
    if (u && String(u.tempCode).trim() === String(code).trim()) {
        res.json({ success: true, user: u });
    } else {
        res.json({ success: false });
    }
});

// ✅ אופטימיזציה קריטית: בטעינת משתמש ראשונית, לא שולחים את הקבצים של ההודעות והחתימות!
app.post('/login-by-id', async (req, res) => {
    try { 
        let user = await User.findById(req.body.userId)
            .select('-messages.attachment -bankAuth.signature -bankAuth.file'); // Exclude heavy fields
        if(user) {
            if ((!user.cards || user.cards.length === 0) && user.token) { 
                user.cards.push({ token: user.token, lastDigits: user.lastCardDigits, expiry: user.lastExpiry, active: true }); 
                user.token = ""; 
                await user.save(); 
            }
            res.json({ success: true, user }); 
        } else res.json({ success: false }); 
    } catch(e) { res.json({ success: false }); }
});

app.post('/donate', async (req, res) => {
    const { userId, amount, useToken, note, forceImmediate, ccDetails, providedPin, isGoalDonation, useReceiptDetails } = req.body;
    let u = await User.findById(userId);
    if (u.securityPin && u.securityPin.trim() !== "") { if (String(providedPin).trim() !== String(u.securityPin).trim()) return res.json({ success: false, error: "קוד אבטחה (PIN) שגוי" }); }
    
    let shouldChargeNow = (isGoalDonation === true) || (forceImmediate === true) ? true : (u.billingPreference === 0 && forceImmediate !== false);
    
    if (shouldChargeNow) {
        try {
            const r = await chargeKesher(u, amount, note, !useToken ? ccDetails : null, useReceiptDetails);
            if (r.success) {
                u.totalDonated += parseFloat(amount);
                u.donationsHistory.push({ 
                    amount: parseFloat(amount), 
                    note, 
                    date: new Date(), 
                    status: 'success',
                    isGoal: isGoalDonation === true,
                    receiptNameUsed: r.receiptNameUsed,
                    receiptTZUsed: r.receiptTZUsed,
                    receiptUrl: r.receiptUrl
                });
                await u.save();

                if (isGoalDonation) {
                    await GlobalGoal.findOneAndUpdate({ id: 'main_goal' }, { $inc: { currentAmount: parseFloat(amount) } });
                }

                res.json({ success: true, message: "תרומה התקבלה!" });
            } else { 
                res.json({ success: false, error: r.data.Description || r.data.errDesc || "סירוב עסקה" }); 
            }
        } catch(e) { 
            console.error("Donate Error:", e);
            res.json({ success: false, error: e.message }); 
        }
    } else {
        u.pendingDonations.push({ amount: parseFloat(amount), note, date: new Date() });
        await u.save();
        res.json({ success: true, message: "נוסף לסל" });
    }
});

app.post('/delete-pending', async (req, res) => { 
    const u = await User.findById(req.body.userId);
    if (u.canRemoveFromBasket === false) { return res.json({ success: false, error: "אין אפשרות להסיר פריטים מהסל (ננעל ע\"י המנהל)" }); }
    await User.findByIdAndUpdate(req.body.userId, { $pull: { pendingDonations: { _id: req.body.donationId } } }); 
    res.json({ success: true }); 
});

// Update Profile - Fixed to include ALL fields
app.post('/admin/update-profile', async (req, res) => {
    try {
        const { userId, name, phone, email, tz, billingPreference, recurringDailyAmount, securityPin, recurringImmediate, newCardDetails, canRemoveFromBasket, activeCardId, deleteCardId, editCardData, addManualCardData, receiptName, receiptTZ, receiptMode, maaserActive, maaserRate, maaserIncome, showTaxWidget } = req.body;
        
        // Handle case where data is nested in userData (client sent JSON.stringify(data) as userData field) or flat
        const updateFields = req.body.userData || req.body;
        // Merge them for safety
        const finalData = { ...req.body, ...req.body.userData };

        let u = await User.findById(finalData.userId || userId);
        
        // Cards Logic
        if (finalData.deleteCardId) { u.cards = u.cards.filter(c => c._id.toString() !== finalData.deleteCardId); if (!u.cards.some(c => c.active) && u.cards.length > 0) { u.cards[0].active = true; } }
        if (finalData.activeCardId) { u.cards.forEach(c => c.active = (c._id.toString() === finalData.activeCardId)); }
        
        if (finalData.newCardDetails && finalData.newCardDetails.num) { 
            try { 
                u.name = finalData.name || u.name; 
                u.phone = finalData.phone || u.phone; 
                u.email = finalData.email || u.email; 
                u.tz = finalData.tz || u.tz; 
                const r = await chargeKesher(u, 0.1, "בדיקת כרטיס", finalData.newCardDetails); 
                if (r.success || (r.data.Description === "עיסקה כפולה" && r.token)) { 
                    const newToken = fixToken(r.token || r.data.Token); 
                    u.cards.forEach(c => c.active = false); 
                    u.cards.push({ token: newToken, lastDigits: r.currentCardDigits, expiry: r.finalExpiry, active: true }); 
                    if(r.success) { u.totalDonated += 0.1; u.donationsHistory.push({ amount: 0.1, note: "שמירת כרטיס", status: 'success', date: new Date(), receiptUrl: r.receiptUrl }); }
                } else { return res.json({ success: false, error: "אימות נכשל: " + r.data.Description }); } 
            } catch(e) { return res.json({ success: false, error: "תקלה: " + e.message }); } 
        }

        if (finalData.addManualCardData) { u.cards.forEach(c => c.active = false); u.cards.push({ token: fixToken(finalData.addManualCardData.token), lastDigits: finalData.addManualCardData.lastDigits, expiry: finalData.addManualCardData.expiry, active: true }); }
        
        // User Details Update
        if(finalData.name !== undefined) u.name = finalData.name;
        if(finalData.phone !== undefined) u.phone = finalData.phone;
        if(finalData.email !== undefined) u.email = finalData.email;
        if(finalData.tz !== undefined) u.tz = finalData.tz;
        
        if(finalData.billingPreference !== undefined) u.billingPreference = parseInt(finalData.billingPreference);
        if(finalData.recurringDailyAmount !== undefined) u.recurringDailyAmount = parseInt(finalData.recurringDailyAmount);
        if(finalData.recurringImmediate !== undefined) u.recurringImmediate = finalData.recurringImmediate;
        if(finalData.securityPin !== undefined) u.securityPin = finalData.securityPin;
        if(finalData.canRemoveFromBasket !== undefined) u.canRemoveFromBasket = finalData.canRemoveFromBasket;
        
        if(finalData.receiptName !== undefined) u.receiptName = finalData.receiptName;
        if(finalData.receiptTZ !== undefined) u.receiptTZ = finalData.receiptTZ;
        if(finalData.receiptMode !== undefined) u.receiptMode = parseInt(finalData.receiptMode);

        if(finalData.maaserActive !== undefined) u.maaserActive = finalData.maaserActive;
        if(finalData.maaserRate !== undefined) u.maaserRate = parseInt(finalData.maaserRate);
        if(finalData.maaserIncome !== undefined) u.maaserIncome = parseInt(finalData.maaserIncome);

        if(finalData.showTaxWidget !== undefined) u.showTaxWidget = finalData.showTaxWidget;

        await u.save();
        res.json({ success: true });
    } catch(e) { res.status(500).json({ success: false, error: e.message }); }
});

// Admin Routes
app.post('/admin/get-users', async (req, res) => { 
    if(req.body.password!=="admin1234") return res.json({success:false}); 
    // Exclude heavy fields from list to prevent lag
    const users = await User.find().select('-messages -bankAuth.signature -bankAuth.file').sort({_id:-1}); 
    res.json({success:true, users}); 
});

app.post('/admin/stats', async (req, res) => { if(req.body.password!=="admin1234") return res.json({success:false}); const { fromDate, toDate } = req.body; let start = fromDate ? new Date(fromDate) : new Date(0); start.setHours(0,0,0,0); let end = toDate ? new Date(toDate) : new Date(); end.setHours(23, 59, 59, 999); const now = new Date(); const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1); const endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59); const users = await User.find(); let totalRange = 0; let countRange = 0; let totalMonth = 0; let uniqueDonors = new Set(); users.forEach(u => u.donationsHistory?.forEach(d => { let dDate = new Date(d.date); if (d.status === 'success') { const amount = d.amount || 0; if (dDate >= start && dDate <= end) { totalRange += amount; countRange++; uniqueDonors.add(u._id.toString()); } if (dDate >= startOfMonth && dDate <= endOfMonth) { totalMonth += amount; } } })); res.json({ success: true, stats: { totalDonated: totalRange, totalDonations: countRange, totalUsers: users.length, uniqueDonorsRange: uniqueDonors.size, totalMonth: totalMonth } }); });
app.post('/admin/add-donation-manual', async (req, res) => { if(req.body.password!=="admin1234") return res.json({success:false}); const { userId, amount, type, note } = req.body; let u = await User.findById(userId); if (!u) return res.json({ success: false, error: "משתמש לא נמצא" }); if (type === 'immediate') { if (!await getActiveToken(u)) return res.json({ success: false, error: "אין כרטיס אשראי שמור" }); try { const r = await chargeKesher(u, amount, note || "חיוב ע\"י מנהל"); if (r.success) { u.totalDonated += parseFloat(amount); u.donationsHistory.push({ amount: parseFloat(amount), note: note || "חיוב יזום ע\"י מנהל", date: new Date(), status: 'success', receiptUrl: r.receiptUrl }); await u.save(); res.json({ success: true }); } else { res.json({ success: false, error: "סירוב: " + (r.data.Description || "שגיאה") }); } } catch (e) { res.json({ success: false, error: e.message }); } } else { u.pendingDonations.push({ amount: parseFloat(amount), note: note || "הוסף ע\"י מנהל", date: new Date() }); await u.save(); res.json({ success: true }); } });
app.post('/admin/remove-from-basket', async (req, res) => { if(req.body.password!=="admin1234") return res.json({success:false}); await User.findByIdAndUpdate(req.body.userId, { $pull: { pendingDonations: { _id: req.body.itemId } } }); res.json({ success: true }); });
app.post('/admin/global-basket-lock', async (req, res) => { if(req.body.password!=="admin1234") return res.json({success:false}); const { allow } = req.body; await User.updateMany({}, { canRemoveFromBasket: allow }); res.json({ success: true }); });
app.get('/goal', async (req, res) => { let g = await GlobalGoal.findOne({ id: 'main_goal' }); if (!g) g = await GlobalGoal.create({ id: 'main_goal', title: 'יעד קהילתי', targetAmount: 1000, currentAmount: 0, isActive: false }); res.json({ success: true, goal: g }); });
app.post('/admin/goal', async (req, res) => { if(req.body.password!=="admin1234") return res.json({success:false}); const { title, targetAmount, isActive, resetCurrent } = req.body; let update = { title, targetAmount, isActive }; if (resetCurrent) update.currentAmount = 0; await GlobalGoal.findOneAndUpdate({ id: 'main_goal' }, update, { upsert: true }); res.json({ success: true }); });
app.post('/admin/get-goal-donors', async (req, res) => { if(req.body.password!=="admin1234") return res.json({success:false}); const users = await User.find({ 'donationsHistory.isGoal': true }); let donors = []; users.forEach(u => { u.donationsHistory.forEach(d => { if(d.isGoal && d.status === 'success') { donors.push({ name: u.name || 'פלוני', amount: d.amount, date: d.date, note: d.note, receiptName: d.receiptNameUsed || (u.name || 'רגיל'), receiptTZ: d.receiptTZUsed || (u.tz || '-') }); } }); }); donors.sort((a,b) => new Date(b.date) - new Date(a.date)); res.json({ success: true, donors }); });
app.post('/admin/update-user-full', async (req, res) => { if(req.body.password!=="admin1234") return res.json({success:false}); await User.findByIdAndUpdate(req.body.userId, req.body.userData); res.json({success:true}); });
app.post('/admin/delete-user', async (req, res) => { if(req.body.password!=="admin1234") return res.json({success:false}); await User.findByIdAndDelete(req.body.userId); res.json({success:true}); });
app.post('/admin/recalc-totals', async (req, res) => { if(req.body.password!=="admin1234") return res.json({success:false}); const users = await User.find(); let c=0; for (const u of users) { let t=0; if(u.donationsHistory) u.donationsHistory.forEach(d => { if(d.status==='success') t += d.amount||0; }); if(u.totalDonated!==t) { u.totalDonated=t; await u.save(); c++; } } res.json({ success: true, count: c }); });
app.post('/admin/send-push', async (req, res) => { if(req.body.password!=="admin1234") return res.json({success:false}); const users = await User.find({ fcmToken: { $exists: true, $ne: "" } }); const tokens = users.map(u => u.fcmToken); if(tokens.length) { const response = await admin.messaging().sendMulticast({ notification: { title: req.body.title, body: req.body.body }, tokens }); res.json({ success: true, sentCount: response.successCount }); } else res.json({ success: false, error: "אין מכשירים" }); });
app.post('/save-push-token', async (req, res) => { await User.findByIdAndUpdate(req.body.userId, { fcmToken: req.body.token }); res.json({ success: true }); });
app.post('/reset-token', async (req, res) => { await User.findByIdAndUpdate(req.body.userId, { token: "", lastCardDigits: "" }); res.json({ success: true }); });

// Bank Authorization Routes
app.post('/bank/request', async (req, res) => {
    const { userId, bankName, branch, account, ownerName, phone, signature, file } = req.body;
    try {
        const u = await User.findById(userId);
        if(!u) return res.json({ success: false, error: "User not found" });
        
        u.bankAuth = { status: 'pending', bankName, branch, account, ownerName, phone, signature, file, requestDate: new Date() };
        await u.save();
        await sendEmail('ceo1@nefesh-ha-chaim.org', 'בקשה להוראת קבע בנקאית', `המשתמש ${ownerName} שלח בקשה להוראת קבע. כנס לממשק לאשר.`);
        res.json({ success: true });
    } catch(e) { res.json({ success: false, error: e.message }); }
});

app.post('/admin/get-bank-requests', async (req, res) => {
    if(req.body.password !== "admin1234") return res.json({ success: false });
    // Include signature and file only here for approval
    const users = await User.find({ 'bankAuth.status': { $in: ['pending', 'active'] } }).select('name bankAuth _id');
    res.json({ success: true, requests: users });
});

app.post('/admin/approve-bank', async (req, res) => {
    if(req.body.password !== "admin1234") return res.json({ success: false });
    const { userId, token, dailyLimit, validUntil, bankDetails } = req.body;
    const u = await User.findById(userId);
    if(!u) return res.json({ success: false });

    u.bankAuth.status = 'active';
    u.bankAuth.token = fixToken(token);
    u.bankAuth.dailyLimit = parseInt(dailyLimit) || 0;
    u.bankAuth.validUntil = validUntil ? new Date(validUntil) : null;
    
    if(bankDetails) {
        if(bankDetails.bankName) u.bankAuth.bankName = bankDetails.bankName;
        if(bankDetails.branch) u.bankAuth.branch = bankDetails.branch;
        if(bankDetails.account) u.bankAuth.account = bankDetails.account;
        if(bankDetails.ownerName) u.bankAuth.ownerName = bankDetails.ownerName;
    }
    
    await u.save();
    res.json({ success: true });
});

app.post('/admin/reject-bank', async (req, res) => {
    if(req.body.password !== "admin1234") return res.json({ success: false });
    const u = await User.findById(req.body.userId);
    if(u) { u.bankAuth.status = 'rejected'; u.bankAuth.token = ''; await u.save(); }
    res.json({ success: true });
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`✅ Server Live`));
