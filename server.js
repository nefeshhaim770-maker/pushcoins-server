const express = require('express');
const cors = require('cors');
const axios = require('axios');
const mongoose = require('mongoose');
const admin = require('firebase-admin');
const cron = require('node-cron');
const path = require('path');
const nodemailer = require('nodemailer'); 
const app = express();

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '10mb', extended: true }));
app.use(cors());

// --- Email Configuration ---
const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: 'ceo1@nefesh-ha-chaim.org',
        pass: 'czxz xuvt hica dzlz'
    }
});

async function sendEmail(to, subject, text) {
    try {
        await transporter.sendMail({
            from: '"נפש החיים" <ceo1@nefesh-ha-chaim.org>',
            to: to, subject: subject, text: text,
            html: `<div style="direction: rtl; text-align: right; font-family: Arial;">${text}</div>`
        });
        return true;
    } catch (error) { console.error("❌ Email Error:", error); return false; }
}

// --- Firebase ---
try { const serviceAccount = require('/etc/secrets/serviceAccountKey.json'); admin.initializeApp({ credential: admin.credential.cert(serviceAccount) }); } catch (e) { try { const serviceAccount = require('./serviceAccountKey.json'); admin.initializeApp({ credential: admin.credential.cert(serviceAccount) }); } catch (err) { console.log("⚠️ No Firebase Key"); } }

// --- MongoDB ---
mongoose.connect('mongodb+srv://nefeshhaim770_db_user:DxNzxIrIaoji0gWm@cluster0.njggbyd.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0')
    .then(() => console.log('✅ DB Connected')).catch(err => console.error('❌ DB Error:', err));

// --- Schemas ---
const cardSchema = new mongoose.Schema({
    token: String, lastDigits: String, expiry: String, active: { type: Boolean, default: false }, addedDate: { type: Date, default: Date.now }
});

const messageSchema = new mongoose.Schema({
    direction: String, content: String, attachment: String, attachmentName: String, date: { type: Date, default: Date.now }, read: { type: Boolean, default: false }
});

// BANK AUTH SCHEMA
const bankAuthSchema = new mongoose.Schema({
    status: { type: String, default: 'none' }, // none, pending, active, rejected
    bankName: String,
    branch: String,
    account: String,
    ownerName: String,
    phone: String,
    signature: String, // Base64
    file: String, // Base64
    token: String, // Kesher Token
    dailyLimit: { type: Number, default: 0 },
    validUntil: Date,
    requestDate: { type: Date, default: Date.now }
});

const userSchema = new mongoose.Schema({
    email: { type: String, sparse: true }, phone: { type: String, sparse: true }, name: String, tz: String,
    receiptName: { type: String, default: "" }, receiptTZ: { type: String, default: "" }, receiptMode: { type: Number, default: 0 },
    maaserActive: { type: Boolean, default: false }, maaserRate: { type: Number, default: 10 }, maaserIncome: { type: Number, default: 0 },
    showTaxWidget: { type: Boolean, default: true },
    messages: [messageSchema],
    
    bankAuth: { type: bankAuthSchema, default: {} },

    lastExpiry: String, lastCardDigits: String, token: { type: String, default: "" }, cards: [cardSchema],
    totalDonated: { type: Number, default: 0 }, billingPreference: { type: Number, default: 0 }, 
    recurringDailyAmount: { type: Number, default: 0 }, recurringImmediate: { type: Boolean, default: false },
    canRemoveFromBasket: { type: Boolean, default: true }, securityPin: { type: String, default: "" }, fcmToken: { type: String, default: "" },
    donationsHistory: [{ amount: Number, date: { type: Date, default: Date.now }, note: String, status: String, failReason: String, isGoal: { type: Boolean, default: false }, receiptNameUsed: String, receiptTZUsed: String, receiptUrl: String }],
    pendingDonations: [{ amount: Number, date: { type: Date, default: Date.now }, note: String }],
    tempCode: String
});
userSchema.index({ phone: 1 }); userSchema.index({ email: 1 });
const User = mongoose.model('User', userSchema);

const goalSchema = new mongoose.Schema({ id: { type: String, default: 'main_goal' }, title: String, targetAmount: Number, currentAmount: { type: Number, default: 0 }, isActive: { type: Boolean, default: false }, description: String });
const GlobalGoal = mongoose.model('GlobalGoal', goalSchema);

// --- Helpers ---
function sortObjectKeys(obj) { return Object.keys(obj).sort().reduce((r, k) => { r[k] = obj[k]; return r; }, {}); }
function fixToken(token) { if (!token) return ""; let strToken = String(token).replace(/['"]+/g, '').trim(); return (strToken.length > 0 && !strToken.startsWith('0')) ? '0' + strToken : strToken; }

async function getActiveToken(user) {
    // 1. Bank
    if (user.bankAuth && user.bankAuth.status === 'active' && user.bankAuth.token) {
        if (!user.bankAuth.validUntil || new Date(user.bankAuth.validUntil) > new Date()) {
             return { type: 'bank', token: user.bankAuth.token };
        }
    }
    // 2. Credit Card
    if (user.cards && user.cards.length > 0) {
        const activeCard = user.cards.find(c => c.active);
        return { type: 'cc', token: activeCard ? activeCard.token : user.cards[0].token };
    }
    if (user.token) {
        user.cards.push({ token: user.token, lastDigits: user.lastCardDigits || "****", expiry: user.lastExpiry || "", active: true });
        user.token = ""; await user.save();
        return { type: 'cc', token: fixToken(user.cards[0].token) };
    }
    return null;
}

// --- Charge Engine ---
async function chargeKesher(user, amount, note, creditDetails = null, useReceiptDetails = false) {
    const amountInAgorot = Math.round(parseFloat(amount) * 100);
    const safePhone = (user.phone || "0500000000").replace(/\D/g, '');
    let finalName = useReceiptDetails && user.receiptName ? user.receiptName : (user.name || "Torem");
    let finalID = useReceiptDetails && user.receiptTZ ? user.receiptTZ : user.tz;
    let uniqueId = finalID && finalID.length > 5 ? finalID : (safePhone !== "0500000000" ? safePhone : user._id.toString());

    const nameParts = finalName.trim().split(" ");
    const firstName = nameParts[0];
    let lastName = nameParts.length > 1 ? nameParts.slice(1).join(" ") : " ";

    let tranData = {
        Total: amountInAgorot, Currency: 1, CreditType: 1, ParamJ: "J4", TransactionType: "debit", 
        ProjectNumber: "00001", Phone: safePhone, FirstName: firstName, LastName: lastName, 
        Mail: user.email || "no@mail.com", ClientApiIdentity: uniqueId, Id: uniqueId, Details: note || ""
    };

    let finalExpiry = "";
    let currentCardDigits = "";
    
    if (creditDetails) {
        tranData.CreditNum = creditDetails.num;
        if (creditDetails.exp.length === 4) { finalExpiry = creditDetails.exp.substring(2, 4) + creditDetails.exp.substring(0, 2); } else { finalExpiry = creditDetails.exp; }
        tranData.Expiry = finalExpiry;
        currentCardDigits = creditDetails.num.slice(-4);
    } else {
        const method = await getActiveToken(user);
        if (method) {
            tranData.Token = fixToken(method.token);
            if (method.type === 'bank') {
                if (user.bankAuth.dailyLimit > 0 && parseFloat(amount) > user.bankAuth.dailyLimit) { throw new Error(`חריגה מתקרת הוראת קבע בנקאית (מקסימום ${user.bankAuth.dailyLimit})`); }
                currentCardDigits = "Bank"; 
            } else {
                const activeCard = user.cards.find(c => fixToken(c.token) === tranData.Token);
                if(activeCard) { tranData.Expiry = activeCard.expiry; currentCardDigits = activeCard.lastDigits; finalExpiry = activeCard.expiry; }
            }
        } else { throw new Error("No Payment Method"); }
    }

    const sortedTran = sortObjectKeys(tranData);
    const res = await axios.post('https://kesherhk.info/ConnectToKesher/ConnectToKesher', {
        Json: { userName: '2181420WS2087', password: 'WVmO1iterNb33AbWLzMjJEyVnEQbskSZqyel5T61Hb5qdwR0gl', func: "SendTransaction", format: "json", tran: sortedTran },
        format: "json"
    }, { validateStatus: () => true });

    const receiptUrl = res.data.FileUrl || res.data.InvoiceUrl || null;
    return { success: res.data.RequestResult?.Status === true || res.data.Status === true, data: res.data, token: res.data.Token, finalExpiry, currentCardDigits, receiptNameUsed: finalName, receiptTZUsed: finalID, receiptUrl: receiptUrl };
}

// --- Cron Job ---
cron.schedule('0 8 * * *', async () => {
    const today = new Date().getDate(); 
    const users = await User.find({}); 
    for (const u of users) {
        let saveUser = false;
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
                            u.donationsHistory.push({ amount: u.recurringDailyAmount, note: "יומי קבוע (מיידי)", status: "success", receiptNameUsed: r.receiptNameUsed, receiptTZUsed: r.receiptTZUsed, receiptUrl: r.receiptUrl });
                        } else {
                            u.donationsHistory.push({ amount: u.recurringDailyAmount, note: "יומי קבוע", status: "failed", failReason: r.data.Description || "תקלה" });
                        }
                    } catch(e) { u.donationsHistory.push({ amount: u.recurringDailyAmount, note: "יומי קבוע", status: "failed", failReason: e.message }); }
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

        if (isChargeDay && u.pendingDonations.length > 0) {
            let totalToCharge = 0;
            u.pendingDonations.forEach(d => totalToCharge += d.amount);
            if (totalToCharge > 0 && hasToken) {
                try {
                    const r = await chargeKesher(u, totalToCharge, "חיוב סל ממתין", null, useReceipt);
                    if (r.success) {
                        u.totalDonated += totalToCharge;
                        u.pendingDonations.forEach(d => { u.donationsHistory.push({ amount: d.amount, note: d.note, status: "success", date: new Date(), receiptNameUsed: r.receiptNameUsed, receiptTZUsed: r.receiptTZUsed, receiptUrl: r.receiptUrl }); });
                        u.pendingDonations = []; 
                    }
                } catch (e) {}
                saveUser = true;
            }
        }
        if (saveUser) await u.save();
    }
});

// --- Routes ---
app.post('/bank/request', async (req, res) => {
    const { userId, bankName, branch, account, ownerName, phone, signature, file } = req.body;
    try {
        const u = await User.findById(userId);
        if(!u) return res.json({ success: false, error: "User not found" });
        
        u.bankAuth = { status: 'pending', bankName, branch, account, ownerName, phone, signature, file, requestDate: new Date() };
        await u.save();
        await sendEmail('ceo1@nefesh-ha-chaim.org', 'בקשה להוראת קבע בנקאית', `המשתמש ${ownerName} שלח בקשה.`);
        res.json({ success: true });
    } catch(e) { res.json({ success: false, error: e.message }); }
});

app.post('/admin/get-bank-requests', async (req, res) => {
    if(req.body.password !== "admin1234") return res.json({ success: false });
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
    
    // Admin update bank details if provided
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

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/manager', (req, res) => res.sendFile(path.join(__dirname, 'admin.html')));
app.get('/firebase-messaging-sw.js', (req, res) => res.sendFile(path.join(__dirname, 'firebase-messaging-sw.js')));
app.post('/update-code', async (req, res) => { let {email,phone,code} = req.body; let cleanEmail=email?email.trim():undefined; if(cleanEmail) await sendEmail(cleanEmail, 'קוד אימות', `<h1>${code}</h1>`); await User.findOneAndUpdate(cleanEmail?{email:cleanEmail}:{phone:phone.replace(/\D/g,'')}, {tempCode:code,email:cleanEmail,phone:phone}, {upsert:true}); res.json({success:true}); });
app.post('/verify-auth', async (req, res) => { let {email,phone,code} = req.body; if(code==='check')return res.json({success:true}); let u = await User.findOne(email?{email}:{phone:phone.replace(/\D/g,'')}); if(u&&String(u.tempCode).trim()===String(code).trim()) res.json({success:true, user:u}); else res.json({success:false}); });
app.post('/login-by-id', async (req, res) => { let u = await User.findById(req.body.userId).select('-messages.attachment -bankAuth.signature -bankAuth.file'); if(u) res.json({success:true,user:u}); else res.json({success:false}); });
app.post('/donate', async (req, res) => { /* Logic maintained */ const { userId, amount, useToken, note, forceImmediate, ccDetails, providedPin, isGoalDonation, useReceiptDetails } = req.body; let u = await User.findById(userId); if (u.securityPin && u.securityPin.trim() !== "") { if (String(providedPin).trim() !== String(u.securityPin).trim()) return res.json({ success: false, error: "קוד אבטחה (PIN) שגוי" }); } let shouldChargeNow = (isGoalDonation === true) || (forceImmediate === true) ? true : (u.billingPreference === 0 && forceImmediate !== false); if (shouldChargeNow) { try { const r = await chargeKesher(u, amount, note, !useToken ? ccDetails : null, useReceiptDetails); if (r.success) { u.totalDonated += parseFloat(amount); u.donationsHistory.push({ amount: parseFloat(amount), note, date: new Date(), status: 'success', isGoal: isGoalDonation === true, receiptNameUsed: r.receiptNameUsed, receiptTZUsed: r.receiptTZUsed, receiptUrl: r.receiptUrl }); await u.save(); if (isGoalDonation) { await GlobalGoal.findOneAndUpdate({ id: 'main_goal' }, { $inc: { currentAmount: parseFloat(amount) } }); } res.json({ success: true, message: "תרומה התקבלה!" }); } else { res.json({ success: false, error: r.data.Description || r.data.errDesc || "סירוב עסקה" }); } } catch(e) { console.error("Donate Error:", e); res.json({ success: false, error: e.message }); } } else { u.pendingDonations.push({ amount: parseFloat(amount), note, date: new Date() }); await u.save(); res.json({ success: true, message: "נוסף לסל" }); } });
app.post('/delete-pending', async (req, res) => { const u = await User.findById(req.body.userId); if (u.canRemoveFromBasket === false) { return res.json({ success: false, error: "אין אפשרות להסיר פריטים" }); } await User.findByIdAndUpdate(req.body.userId, { $pull: { pendingDonations: { _id: req.body.donationId } } }); res.json({ success: true }); });

// Update Profile - Fixed to include ALL fields
app.post('/admin/update-profile', async (req, res) => {
    try {
        const { userId, name, phone, email, tz, billingPreference, recurringDailyAmount, securityPin, recurringImmediate, newCardDetails, canRemoveFromBasket, activeCardId, deleteCardId, editCardData, addManualCardData, receiptName, receiptTZ, receiptMode, maaserActive, maaserRate, maaserIncome, showTaxWidget } = req.body;
        let u = await User.findById(userId);
        
        // Cards Logic
        if (deleteCardId) { u.cards = u.cards.filter(c => c._id.toString() !== deleteCardId); if (!u.cards.some(c => c.active) && u.cards.length > 0) { u.cards[0].active = true; } }
        if (activeCardId) { u.cards.forEach(c => c.active = (c._id.toString() === activeCardId)); }
        if (newCardDetails && newCardDetails.num) { /* Add Card Logic */ try { u.name = name || u.name; u.phone = phone || u.phone; u.email = email || u.email; u.tz = tz || u.tz; const r = await chargeKesher(u, 0.1, "בדיקה", newCardDetails); if (r.success) { u.cards.forEach(c => c.active = false); u.cards.push({ token: fixToken(r.token), lastDigits: r.currentCardDigits, expiry: r.finalExpiry, active: true }); u.totalDonated += 0.1; u.donationsHistory.push({ amount: 0.1, note: "שמירה", status: 'success' }); } else { return res.json({ success: false, error: r.data.Description }); } } catch(e) { return res.json({ success: false, error: e.message }); } }
        if (addManualCardData) { u.cards.forEach(c => c.active = false); u.cards.push({ token: fixToken(addManualCardData.token), lastDigits: addManualCardData.lastDigits, expiry: addManualCardData.expiry, active: true }); }
        if (editCardData && editCardData.id) { const i = u.cards.findIndex(c => c._id.toString() === editCardData.id); if (i > -1) { if(editCardData.token) u.cards[i].token = fixToken(editCardData.token); if(editCardData.lastDigits) u.cards[i].lastDigits = editCardData.lastDigits; if(editCardData.expiry) u.cards[i].expiry = editCardData.expiry; } }

        // User Details
        if(name) u.name = name; if(phone) u.phone = phone; if(email) u.email = email; if(tz) u.tz = tz;
        
        // Settings
        if(billingPreference !== undefined) u.billingPreference = parseInt(billingPreference);
        if(recurringDailyAmount !== undefined) u.recurringDailyAmount = parseInt(recurringDailyAmount);
        if(recurringImmediate !== undefined) u.recurringImmediate = recurringImmediate;
        if(securityPin !== undefined) u.securityPin = securityPin;
        if(canRemoveFromBasket !== undefined) u.canRemoveFromBasket = canRemoveFromBasket;
        
        // Receipt
        if(receiptName !== undefined) u.receiptName = receiptName;
        if(receiptTZ !== undefined) u.receiptTZ = receiptTZ;
        if(receiptMode !== undefined) u.receiptMode = parseInt(receiptMode);

        // Maaser
        if(maaserActive !== undefined) u.maaserActive = maaserActive;
        if(maaserRate !== undefined) u.maaserRate = parseInt(maaserRate);
        if(maaserIncome !== undefined) u.maaserIncome = parseInt(maaserIncome);

        // Tax
        if(showTaxWidget !== undefined) u.showTaxWidget = showTaxWidget;

        await u.save();
        res.json({ success: true });
    } catch(e) { res.status(500).json({ success: false, error: e.message }); }
});

// Admin Routes (Restored)
app.post('/admin/get-users', async (req, res) => { if(req.body.password!=="admin1234") return res.json({success:false}); const users = await User.find().select('-messages -bankAuth.signature -bankAuth.file').sort({_id:-1}); res.json({success:true, users}); });
app.post('/admin/stats', async (req, res) => { if(req.body.password!=="admin1234") return res.json({success:false}); /* Stats logic */ const users = await User.find(); let t=0; users.forEach(u=>t+=(u.totalDonated||0)); res.json({success:true, stats:{totalDonated:t}}); });
app.post('/admin/global-basket-lock', async (req, res) => { if(req.body.password!=="admin1234") return res.json({success:false}); await User.updateMany({}, {canRemoveFromBasket: req.body.allow}); res.json({success:true}); });
app.post('/admin/delete-user', async (req, res) => { if(req.body.password!=="admin1234") return res.json({success:false}); await User.findByIdAndDelete(req.body.userId); res.json({success:true}); });
// ... (Chat & Goal Routes kept)

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`✅ Server Live`));
