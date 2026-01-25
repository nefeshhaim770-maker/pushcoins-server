const express = require('express');
const cors = require('cors');
const axios = require('axios');
const mongoose = require('mongoose');
const admin = require('firebase-admin');
const cron = require('node-cron');
const path = require('path');
// const compression = require('compression'); // REMOVED to prevent crash if not installed
const app = express();

// Increase payload limit for file uploads/signatures (Base64)
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '10mb', extended: true }));
app.use(cors());

// --- Firebase ---
try {
    const serviceAccount = require('/etc/secrets/serviceAccountKey.json'); 
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
} catch (e) {
    try {
        const serviceAccount = require('./serviceAccountKey.json');
        admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
    } catch (err) { console.log("⚠️ No Firebase Key - Push notifications won't work"); }
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

// Bank Details Sub-Schema
const bankDetailsSchema = new mongoose.Schema({
    bankId: String,      // מספר בנק
    branchId: String,    // מספר סניף
    accountId: String,   // מספר חשבון
    ownerName: String,   // שם בעל חשבון
    ownerID: String,     // תז בעל חשבון
    ownerPhone: String,  // טלפון
    signature: String,   // Base64 Signature
    authFile: String,    // Base64 Uploaded File
    submissionType: String, // 'digital' or 'upload' or 'manual'
    status: { type: String, default: 'none' }, // none, pending, active, rejected
    dailyLimit: { type: Number, default: 0 }, 
    validUntil: { type: Date }, 
    approvedDate: Date
});

const userSchema = new mongoose.Schema({
    email: { type: String, sparse: true },
    phone: { type: String, sparse: true },
    name: String,
    tz: String,
    
    receiptName: { type: String, default: "" },
    receiptTZ: { type: String, default: "" },
    receiptMode: { type: Number, default: 0 }, 
    
    maaserActive: { type: Boolean, default: false },
    maaserRate: { type: Number, default: 10 },
    maaserIncome: { type: Number, default: 0 },

    showTaxWidget: { type: Boolean, default: true },

    messages: [messageSchema],

    lastExpiry: String,
    lastCardDigits: String,
    token: { type: String, default: "" },
    cards: [cardSchema],
    
    // --- Bank Auth ---
    bankDetails: { type: bankDetailsSchema, default: {} },
    preferredPaymentMethod: { type: String, default: 'cc' }, // 'cc' or 'bank'

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
        paymentMethod: String, // 'cc' or 'bank'
        receiptNameUsed: String,
        receiptTZUsed: String
    }],
    pendingDonations: [{ amount: Number, date: { type: Date, default: Date.now }, note: String }],
    tempCode: String
});
const User = mongoose.model('User', userSchema);

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
    return Object.keys(obj).sort().reduce((r, k) => { r[k] = obj[k]; return r; }, {}); 
}

function fixToken(token) {
    if (!token) return "";
    let strToken = String(token).replace(/['"]+/g, '').trim();
    return (strToken.length > 0 && !strToken.startsWith('0')) ? '0' + strToken : strToken;
}

async function getActiveToken(user) {
    if (user.cards && user.cards.length > 0) {
        const activeCard = user.cards.find(c => c.active);
        return activeCard ? activeCard.token : user.cards[0].token;
    }
    if (user.token) {
        user.cards.push({ token: user.token, lastDigits: user.lastCardDigits || "****", expiry: user.lastExpiry || "", active: true });
        user.token = ""; 
        await user.save();
        return fixToken(user.cards[0].token);
    }
    return null;
}

// --- Charge Engine ---
async function chargeKesher(user, amount, note, creditDetails = null, useReceiptDetails = false) {
    const amountInAgorot = Math.round(parseFloat(amount) * 100);
    const safePhone = (user.phone || "0500000000").replace(/\D/g, '');
    
    // Check if Bank Payment is requested
    const isBankPayment = user.preferredPaymentMethod === 'bank';
    
    if (isBankPayment && creditDetails === null) {
        if (!user.bankDetails || user.bankDetails.status !== 'active') {
            throw new Error("אין הרשאה בנקאית פעילה");
        }
        if (user.bankDetails.validUntil && new Date() > new Date(user.bankDetails.validUntil)) {
            throw new Error("תוקף ההרשאה הבנקאית פג");
        }
    }

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
        Total: amountInAgorot, Currency: 1, ParamJ: "J4", TransactionType: "debit", 
        ProjectNumber: "00001", Phone: safePhone, FirstName: firstName, LastName: lastName, 
        Mail: user.email || "no@mail.com", ClientApiIdentity: uniqueId, Id: uniqueId, Details: note || ""
    };

    let finalExpiry = "";
    let currentCardDigits = "";
    
    if (isBankPayment && !creditDetails) {
        // --- Bank Transaction Logic (Masav) ---
        // Note: You need to verify exact params for Masav with Kesher documentation
        tranData.CreditType = 8; // Usually code for Masav/Bank
        tranData.BankNumber = user.bankDetails.bankId;
        tranData.BranchNumber = user.bankDetails.branchId;
        tranData.AccountNumber = user.bankDetails.accountId;
        tranData.OwnerID = user.bankDetails.ownerID || uniqueId;
        tranData.OwnerName = user.bankDetails.ownerName || finalName;
        
        currentCardDigits = "Bank-" + user.bankDetails.accountId.slice(-3);
        console.log(`🏦 Preparing BANK Transaction for ${user.name}`);
    } else {
        // --- Credit Card Logic ---
        tranData.CreditType = 1;
        if (creditDetails) {
            tranData.CreditNum = creditDetails.num;
            if (creditDetails.exp.length === 4) { finalExpiry = creditDetails.exp.substring(2, 4) + creditDetails.exp.substring(0, 2); } else { finalExpiry = creditDetails.exp; }
            tranData.Expiry = finalExpiry;
            currentCardDigits = creditDetails.num.slice(-4);
        } else {
            let usedToken = await getActiveToken(user);
            if (usedToken) {
                tranData.Token = fixToken(usedToken);
                const activeCard = user.cards.find(c => fixToken(c.token) === tranData.Token);
                if(activeCard) { 
                    tranData.Expiry = activeCard.expiry; 
                    currentCardDigits = activeCard.lastDigits; 
                    finalExpiry = activeCard.expiry; 
                }
            } else { throw new Error("No Payment Method"); }
        }
    }

    const sortedTran = sortObjectKeys(tranData);
    console.log(`🚀 Sending Transaction:`, JSON.stringify(sortedTran));

    const res = await axios.post('https://kesherhk.info/ConnectToKesher/ConnectToKesher', {
        Json: { userName: '2181420WS2087', password: 'WVmO1iterNb33AbWLzMjJEyVnEQbskSZqyel5T61Hb5qdwR0gl', func: "SendTransaction", format: "json", tran: sortedTran },
        format: "json"
    }, { validateStatus: () => true });

    console.log(`📩 Response:`, JSON.stringify(res.data));

    const isSuccess = res.data.RequestResult?.Status === true || res.data.Status === true;

    return { 
        success: isSuccess, 
        data: res.data, 
        token: res.data.Token, 
        finalExpiry, 
        currentCardDigits,
        receiptNameUsed: finalName,
        receiptTZUsed: finalID,
        paymentMethod: isBankPayment && !creditDetails ? 'bank' : 'cc'
    };
}

// --- Cron Job ---
cron.schedule('0 8 * * *', async () => {
    const today = new Date().getDate(); 
    console.log(`⏳ Starting Daily Cron. Day: ${today}`); 

    const users = await User.find({}); 
    for (const u of users) {
        let saveUser = false;
        
        let canCharge = false;
        const isBank = u.preferredPaymentMethod === 'bank';
        
        if (isBank) {
            if (u.bankDetails && u.bankDetails.status === 'active') {
                const isValidDate = !u.bankDetails.validUntil || new Date() <= new Date(u.bankDetails.validUntil);
                if (isValidDate) canCharge = true;
            }
        } else {
            if (await getActiveToken(u)) canCharge = true;
        }

        const useReceipt = (u.receiptMode === 1 && u.receiptName && u.receiptTZ);

        // --- Recurring ---
        if (u.recurringDailyAmount > 0) {
            let amountToCharge = u.recurringDailyAmount;
            if (isBank && u.bankDetails.dailyLimit > 0 && amountToCharge > u.bankDetails.dailyLimit) {
                console.log(`⚠️ Bank limit exceeded for ${u.name}.`);
                canCharge = false; 
            }

            if (u.recurringImmediate === true || u.billingPreference === 0) {
                if(canCharge) {
                    try {
                        const r = await chargeKesher(u, amountToCharge, "הוראת קבע יומית", null, useReceipt);
                        if (r.success) {
                            u.totalDonated += amountToCharge;
                            u.donationsHistory.push({ 
                                amount: amountToCharge, note: "יומי קבוע (מיידי)", status: "success", 
                                receiptNameUsed: r.receiptNameUsed, receiptTZUsed: r.receiptTZUsed, paymentMethod: r.paymentMethod 
                            });
                        } else {
                            const failReason = r.data.Description || r.data.errDesc || "תקלה בסליקה";
                            u.donationsHistory.push({ amount: amountToCharge, note: "יומי קבוע", status: "failed", failReason: failReason, paymentMethod: isBank?'bank':'cc' });
                        }
                    } catch(e) {
                        u.donationsHistory.push({ amount: amountToCharge, note: "יומי קבוע", status: "failed", failReason: e.message, paymentMethod: isBank?'bank':'cc' });
                    }
                    saveUser = true;
                }
            } else {
                u.pendingDonations.push({ amount: amountToCharge, note: "יומי קבוע (הצטברות)" });
                saveUser = true;
            }
        }

        // --- Basket ---
        const prefDay = parseInt(u.billingPreference);
        const currentDay = parseInt(today);
        const isChargeDay = (prefDay === currentDay);
        const isImmediateUser = (prefDay === 0);

        if ((isChargeDay || isImmediateUser) && u.pendingDonations.length > 0) {
            let totalToCharge = 0;
            u.pendingDonations.forEach(d => totalToCharge += d.amount);
            
            if (isBank && u.bankDetails.dailyLimit > 0 && totalToCharge > u.bankDetails.dailyLimit) {
                 canCharge = false; 
            }

            if (totalToCharge > 0 && canCharge) {
                try {
                    const r = await chargeKesher(u, totalToCharge, "חיוב סל ממתין", null, useReceipt);
                    if (r.success) {
                        u.totalDonated += totalToCharge;
                        u.pendingDonations.forEach(d => { 
                            u.donationsHistory.push({ 
                                amount: d.amount, note: d.note, status: "success", date: new Date(), 
                                receiptNameUsed: r.receiptNameUsed, receiptTZUsed: r.receiptTZUsed, paymentMethod: r.paymentMethod
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

// --- BANK ROUTES ---
app.post('/user/submit-bank-auth', async (req, res) => {
    const { userId, bankId, branchId, accountId, ownerName, ownerID, ownerPhone, signature, file, type } = req.body;
    try {
        const u = await User.findById(userId);
        if (!u) return res.json({ success: false, error: 'User not found' });

        if (type === 'digital') {
            if(!signature && !file) return res.json({success: false, error: "חייב חתימה"});
            u.bankDetails = {
                bankId, branchId, accountId, ownerName, ownerID, ownerPhone,
                signature: signature || "", 
                authFile: file || "",
                submissionType: 'digital',
                status: 'pending',
                dailyLimit: 0
            };
        } else if (type === 'upload') {
             u.bankDetails = {
                authFile: file,
                submissionType: 'upload',
                status: 'pending',
                dailyLimit: 0
            };
        }

        u.preferredPaymentMethod = 'bank'; 
        
        u.messages.push({
            direction: 'user_to_admin',
            content: `בקשה להרשאה בנקאית (${type}). נא לאשר בניהול בנקים.`,
            date: new Date(),
            read: false
        });

        await u.save();
        res.json({ success: true });
    } catch (e) { res.json({ success: false, error: e.message }); }
});

app.post('/admin/manage-bank-auth', async (req, res) => {
    if(req.body.password !== PASS) return res.json({ success: false });
    const { userId, action, data } = req.body; 
    
    try {
        const u = await User.findById(userId);
        if (!u) return res.json({ success: false });

        if (action === 'approve') {
            u.bankDetails.status = 'active';
            u.bankDetails.approvedDate = new Date();
            u.bankDetails.dailyLimit = data.limit ? parseInt(data.limit) : 0;
            if (data.validUntil) u.bankDetails.validUntil = new Date(data.validUntil);
            u.preferredPaymentMethod = 'bank';
            u.messages.push({ direction: 'admin_to_user', content: 'הוראת הקבע הבנקאית אושרה.', date: new Date(), read: false });
        } 
        else if (action === 'reject') {
            u.bankDetails.status = 'rejected';
            u.preferredPaymentMethod = 'cc';
             u.messages.push({ direction: 'admin_to_user', content: 'הוראת הקבע הבנקאית נדחתה.', date: new Date(), read: false });
        }
        else if (action === 'manual_setup') {
            // Admin manually sets up bank for user
            u.bankDetails = {
                bankId: data.bankId, 
                branchId: data.branchId, 
                accountId: data.accountId,
                ownerName: data.ownerName, 
                ownerID: data.ownerID, // Save ID
                status: 'active', // Immediately active
                dailyLimit: data.limit ? parseInt(data.limit) : 0,
                submissionType: 'manual', 
                approvedDate: new Date()
            };
            if (data.validUntil) u.bankDetails.validUntil = new Date(data.validUntil);
            u.preferredPaymentMethod = 'bank';
            u.messages.push({ direction: 'admin_to_user', content: 'הוגדרה הוראת קבע בנקאית ע"י ההנהלה.', date: new Date(), read: false });
        }

        await u.save();
        res.json({ success: true });
    } catch(e) { res.json({ success: false, error: e.message }); }
});

app.post('/admin/get-bank-requests', async (req, res) => {
    if(req.body.password !== PASS) return res.json({ success: false });
    const users = await User.find({ 
        $or: [{ 'bankDetails.status': 'pending' }, { 'bankDetails.status': 'active' }, { 'bankDetails.status': 'rejected' }]
    }).select('name phone email bankDetails _id');
    res.json({ success: true, users });
});

// --- EXISTING ROUTES ---
app.post('/contact/send', async (req, res) => {
    const { userId, content, attachment, attachmentName } = req.body;
    try {
        const u = await User.findById(userId);
        if(!u) return res.json({ success: false, error: 'User not found' });
        u.messages.push({ direction: 'user_to_admin', content, attachment, attachmentName, read: false, date: new Date() });
        await u.save();
        res.json({ success: true });
    } catch(e) { res.json({ success: false, error: e.message }); }
});

app.post('/admin/reply', async (req, res) => {
    if(req.body.password !== PASS) return res.json({ success: false });
    const { userId, content, attachment, attachmentName } = req.body;
    try {
        const u = await User.findById(userId);
        if(!u) return res.json({ success: false });
        u.messages.push({ direction: 'admin_to_user', content, attachment, attachmentName, read: false, date: new Date() });
        await u.save();
        if(u.fcmToken) { try { await admin.messaging().send({ token: u.fcmToken, notification: { title: 'הודעה חדשה', body: content||'קובץ' } }); } catch(e) {} }
        res.json({ success: true });
    } catch(e) { res.json({ success: false, error: e.message }); }
});

app.post('/admin/get-messages', async (req, res) => {
    if(req.body.password !== PASS) return res.json({ success: false });
    const users = await User.find({ 'messages.0': { $exists: true } }).select('name phone messages _id');
    const sortedUsers = users.map(u => {
        const lastMsg = u.messages[u.messages.length - 1];
        const unreadCount = u.messages.filter(m => m.direction === 'user_to_admin' && !m.read).length;
        return { _id: u._id, name: u.name, phone: u.phone, lastMessageDate: lastMsg ? lastMsg.date : 0, unreadCount, messages: u.messages };
    }).sort((a,b) => new Date(b.lastMessageDate) - new Date(a.lastMessageDate));
    res.json({ success: true, users: sortedUsers });
});

app.post('/admin/mark-read', async (req, res) => {
    if(req.body.password !== PASS) return res.json({ success: false });
    await User.updateOne({ _id: req.body.userId }, { $set: { "messages.$[elem].read": true } }, { arrayFilters: [{ "elem.direction": "user_to_admin" }] });
    res.json({ success: true });
});

app.post('/user/mark-read', async (req, res) => {
    await User.updateOne({ _id: req.body.userId }, { $set: { "messages.$[elem].read": true } }, { arrayFilters: [{ "elem.direction": "admin_to_user" }] });
    res.json({ success: true });
});

app.post('/update-code', async (req, res) => {
    let { email, phone, code } = req.body;
    let cleanEmail = email ? email.toLowerCase().trim() : undefined;
    let cleanPhone = phone ? phone.replace(/\D/g, '').trim() : undefined;
    if (cleanEmail) { try { await axios.post('https://api.emailjs.com/api/v1.0/email/send', { service_id: 'service_8f6h188', template_id: 'template_tzbq0k4', user_id: 'yLYooSdg891aL7etD', template_params: { email: cleanEmail, code: code }, accessToken: "b-Dz-J0Iq_yJvCfqX5Iw3" }); } catch (e) {} }
    await User.findOneAndUpdate(cleanEmail ? { email: cleanEmail } : { phone: cleanPhone }, { tempCode: code, email: cleanEmail, phone: cleanPhone }, { upsert: true });
    res.json({ success: true });
});

app.post('/send-verification', async (req, res) => {
    try { await axios.post('https://api.emailjs.com/api/v1.0/email/send', { service_id: 'service_8f6h188', template_id: 'template_tzbq0k4', user_id: 'yLYooSdg891aL7etD', template_params: { email: req.body.email, code: req.body.code }, accessToken: "b-Dz-J0Iq_yJvCfqX5Iw3" }); res.json({ success: true }); } catch(e) { res.json({ success: false }); }
});

app.post('/verify-auth', async (req, res) => {
    let { email, phone, code } = req.body;
    if(code === 'check') return res.json({ success: true });
    let u = await User.findOne(email ? { email: email.toLowerCase().trim() } : { phone: phone.replace(/\D/g, '').trim() });
    if (u && String(u.tempCode).trim() === String(code).trim()) res.json({ success: true, user: u }); else res.json({ success: false });
});

app.post('/login-by-id', async (req, res) => {
    try { let user = await User.findById(req.body.userId); if(user) { if ((!user.cards || user.cards.length === 0) && user.token) { user.cards.push({ token: user.token, lastDigits: user.lastCardDigits, expiry: user.lastExpiry, active: true }); user.token = ""; await user.save(); } res.json({ success: true, user }); } else res.json({ success: false }); } catch(e) { res.json({ success: false }); }
});

app.post('/donate', async (req, res) => {
    const { userId, amount, useToken, note, forceImmediate, ccDetails, providedPin, isGoalDonation, useReceiptDetails } = req.body;
    let u = await User.findById(userId);
    if (u.securityPin && u.securityPin.trim() !== "") { if (String(providedPin).trim() !== String(u.securityPin).trim()) return res.json({ success: false, error: "קוד אבטחה שגוי" }); }
    
    let shouldChargeNow = (isGoalDonation === true) || (forceImmediate === true) ? true : (u.billingPreference === 0 && forceImmediate !== false);
    
    if (shouldChargeNow) {
        try {
            if (u.preferredPaymentMethod === 'bank' && u.bankDetails.dailyLimit > 0 && parseFloat(amount) > u.bankDetails.dailyLimit) {
                return res.json({ success: false, error: "סכום התרומה חורג מהתקרה היומית שהוגדרה להוראת הקבע" });
            }
            const r = await chargeKesher(u, amount, note, !useToken ? ccDetails : null, useReceiptDetails);
            if (r.success) {
                u.totalDonated += parseFloat(amount);
                u.donationsHistory.push({ amount: parseFloat(amount), note, date: new Date(), status: 'success', isGoal: isGoalDonation === true, receiptNameUsed: r.receiptNameUsed, receiptTZUsed: r.receiptTZUsed, paymentMethod: r.paymentMethod });
                await u.save();
                if (isGoalDonation) { await GlobalGoal.findOneAndUpdate({ id: 'main_goal' }, { $inc: { currentAmount: parseFloat(amount) } }); }
                res.json({ success: true, message: "תרומה התקבלה!" });
            } else { res.json({ success: false, error: r.data.Description || "סירוב" }); }
        } catch(e) { res.json({ success: false, error: e.message }); }
    } else {
        u.pendingDonations.push({ amount: parseFloat(amount), note, date: new Date() });
        await u.save();
        res.json({ success: true, message: "נוסף לסל" });
    }
});

app.post('/delete-pending', async (req, res) => { const u = await User.findById(req.body.userId); if (u.canRemoveFromBasket === false) { return res.json({ success: false, error: "ננעל ע\"י מנהל" }); } await User.findByIdAndUpdate(req.body.userId, { $pull: { pendingDonations: { _id: req.body.donationId } } }); res.json({ success: true }); });

app.post('/admin/update-profile', async (req, res) => {
    try {
        const { userId, name, phone, email, tz, billingPreference, recurringDailyAmount, securityPin, recurringImmediate, newCardDetails, canRemoveFromBasket, activeCardId, deleteCardId, editCardData, addManualCardData, receiptName, receiptTZ, receiptMode, maaserActive, maaserRate, maaserIncome, showTaxWidget } = req.body;
        let u = await User.findById(userId);
        
        if (deleteCardId) { u.cards = u.cards.filter(c => c._id.toString() !== deleteCardId); if (!u.cards.some(c => c.active) && u.cards.length > 0) { u.cards[0].active = true; } }
        if (activeCardId) { u.cards.forEach(c => c.active = (c._id.toString() === activeCardId)); }
        
        if (newCardDetails && newCardDetails.num) {
            try {
                u.name = name || u.name; u.phone = phone || u.phone; u.email = email || u.email; u.tz = tz || u.tz;
                const r = await chargeKesher(u, 0.1, "בדיקת כרטיס", newCardDetails);
                if (r.success || (r.data.Description === "עיסקה כפולה" && r.token)) {
                    u.cards.forEach(c => c.active = false);
                    u.cards.push({ token: fixToken(r.token), lastDigits: r.currentCardDigits, expiry: r.finalExpiry, active: true });
                    if(r.success) { u.totalDonated += 0.1; u.donationsHistory.push({ amount: 0.1, note: "בדיקת כרטיס", status: 'success', date: new Date() }); }
                } else return res.json({ success: false, error: "אימות נכשל" });
            } catch(e) { return res.json({ success: false, error: e.message }); }
        }

        if (addManualCardData) { u.cards.forEach(c => c.active = false); u.cards.push({ token: fixToken(addManualCardData.token), lastDigits: addManualCardData.lastDigits, expiry: addManualCardData.expiry, active: true }); }
        
        if(name) u.name = name; if(phone) u.phone = phone; if(email) u.email = email; if(tz) u.tz = tz;
        u.billingPreference = parseInt(billingPreference)||0; u.recurringDailyAmount = parseInt(recurringDailyAmount)||0; u.recurringImmediate = recurringImmediate===true; u.securityPin = securityPin; u.canRemoveFromBasket = canRemoveFromBasket;
        if(receiptName !== undefined) u.receiptName = receiptName; if(receiptTZ !== undefined) u.receiptTZ = receiptTZ; if(receiptMode !== undefined) u.receiptMode = parseInt(receiptMode);
        if(maaserActive !== undefined) u.maaserActive = maaserActive; if(maaserRate !== undefined) u.maaserRate = parseInt(maaserRate); if(maaserIncome !== undefined) u.maaserIncome = parseInt(maaserIncome);
        if(showTaxWidget !== undefined) u.showTaxWidget = showTaxWidget;

        await u.save();
        res.json({ success: true });
    } catch(e) { res.status(500).json({ success: false, error: e.message }); }
});

// Admin misc routes
const PASS = "admin1234";
app.post('/admin/stats', async (req, res) => { if(req.body.password !== PASS) return res.json({ success: false }); const { fromDate, toDate } = req.body; let start = fromDate ? new Date(fromDate) : new Date(0); start.setHours(0,0,0,0); let end = toDate ? new Date(toDate) : new Date(); end.setHours(23, 59, 59, 999); const now = new Date(); const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1); const endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59); const users = await User.find(); let totalRange = 0; let countRange = 0; let totalMonth = 0; let uniqueDonors = new Set(); users.forEach(u => u.donationsHistory?.forEach(d => { let dDate = new Date(d.date); if (d.status === 'success') { const amount = d.amount || 0; if (dDate >= start && dDate <= end) { totalRange += amount; countRange++; uniqueDonors.add(u._id.toString()); } if (dDate >= startOfMonth && dDate <= endOfMonth) { totalMonth += amount; } } })); res.json({ success: true, stats: { totalDonated: totalRange, totalDonations: countRange, totalUsers: users.length, uniqueDonorsRange: uniqueDonors.size, totalMonth: totalMonth } }); });
app.post('/admin/add-donation-manual', async (req, res) => { if(req.body.password !== PASS) return res.json({ success: false }); const { userId, amount, type, note } = req.body; let u = await User.findById(userId); if (!u) return res.json({ success: false, error: "לא נמצא" }); if (type === 'immediate') { try { const r = await chargeKesher(u, amount, note || "חיוב מנהל"); if (r.success) { u.totalDonated += parseFloat(amount); u.donationsHistory.push({ amount: parseFloat(amount), note: note || "חיוב מנהל", date: new Date(), status: 'success', paymentMethod: r.paymentMethod }); await u.save(); res.json({ success: true }); } else { res.json({ success: false, error: "סירוב" }); } } catch (e) { res.json({ success: false, error: e.message }); } } else { u.pendingDonations.push({ amount: parseFloat(amount), note: note || "הוסף ע\"י מנהל", date: new Date() }); await u.save(); res.json({ success: true }); } });
app.post('/admin/remove-from-basket', async (req, res) => { if(req.body.password !== PASS) return res.json({ success: false }); await User.findByIdAndUpdate(req.body.userId, { $pull: { pendingDonations: { _id: req.body.itemId } } }); res.json({ success: true }); });
app.post('/admin/global-basket-lock', async (req, res) => { if(req.body.password !== PASS) return res.json({ success: false }); await User.updateMany({}, { canRemoveFromBasket: req.body.allow }); res.json({ success: true }); });
app.get('/goal', async (req, res) => { let g = await GlobalGoal.findOne({ id: 'main_goal' }); if (!g) g = await GlobalGoal.create({ id: 'main_goal', title: 'יעד קהילתי', targetAmount: 1000 }); res.json({ success: true, goal: g }); });
app.post('/admin/goal', async (req, res) => { if(req.body.password !== PASS) return res.json({ success: false }); let update = { title: req.body.title, targetAmount: req.body.targetAmount, isActive: req.body.isActive }; if (req.body.resetCurrent) update.currentAmount = 0; await GlobalGoal.findOneAndUpdate({ id: 'main_goal' }, update, { upsert: true }); res.json({ success: true }); });
app.post('/admin/get-goal-donors', async (req, res) => { if(req.body.password !== PASS) return res.json({ success: false }); const users = await User.find({ 'donationsHistory.isGoal': true }); let donors = []; users.forEach(u => { u.donationsHistory.forEach(d => { if(d.isGoal && d.status === 'success') { donors.push({ name: u.name, amount: d.amount, date: d.date, note: d.note, receiptName: d.receiptNameUsed, receiptTZ: d.receiptTZUsed }); } }); }); res.json({ success: true, donors: donors.sort((a,b) => new Date(b.date) - new Date(a.date)) }); });
app.post('/admin/get-users', async (req, res) => { if(req.body.password !== PASS) return res.json({ success: false }); const users = await User.find().sort({ _id: -1 }); res.json({ success: true, users }); });
app.post('/admin/update-user-full', async (req, res) => { if(req.body.password !== PASS) return res.json({ success: false }); await User.findByIdAndUpdate(req.body.userId, req.body.userData); res.json({ success: true }); });
app.post('/admin/delete-user', async (req, res) => { if(req.body.password !== PASS) return res.json({ success: false }); await User.findByIdAndDelete(req.body.userId); res.json({ success: true }); });
app.post('/admin/send-push', async (req, res) => { if(req.body.password !== PASS) return res.json({ success: false }); const users = await User.find({ fcmToken: { $exists: true, $ne: "" } }); const tokens = users.map(u => u.fcmToken); if(tokens.length) { await admin.messaging().sendMulticast({ notification: { title: req.body.title, body: req.body.body }, tokens }); res.json({ success: true }); } else res.json({ success: false }); });
app.post('/save-push-token', async (req, res) => { await User.findByIdAndUpdate(req.body.userId, { fcmToken: req.body.token }); res.json({ success: true }); });
app.post('/reset-token', async (req, res) => { await User.findByIdAndUpdate(req.body.userId, { token: "", lastCardDigits: "" }); res.json({ success: true }); });

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`✅ Server Live`));
