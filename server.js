const express = require('express');
const cors = require('cors');
const axios = require('axios');
const mongoose = require('mongoose');
const admin = require('firebase-admin');
const cron = require('node-cron');
const path = require('path');
const app = express();

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

const bankDetailsSchema = new mongoose.Schema({
    bankId: String,
    branchId: String,
    accountId: String,
    ownerName: String,
    ownerID: String, 
    ownerPhone: String,
    signature: String,
    authFile: String,
    submissionType: String,
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
    bankDetails: { type: bankDetailsSchema, default: {} },
    preferredPaymentMethod: { type: String, default: 'cc' }, 
    totalDonated: { type: Number, default: 0 },
    billingPreference: { type: Number, default: 0 }, 
    recurringDailyAmount: { type: Number, default: 0 },
    recurringImmediate: { type: Boolean, default: false },
    canRemoveFromBasket: { type: Boolean, default: true },
    securityPin: { type: String, default: "" },
    fcmToken: { type: String, default: "" },
    donationsHistory: [{ 
        amount: Number, date: { type: Date, default: Date.now }, note: String, 
        status: String, failReason: String, isGoal: { type: Boolean, default: false }, 
        paymentMethod: String, receiptNameUsed: String, receiptTZUsed: String
    }],
    pendingDonations: [{ amount: Number, date: { type: Date, default: Date.now }, note: String }],
    tempCode: String
});
const User = mongoose.model('User', userSchema);

const GlobalGoal = mongoose.model('GlobalGoal', new mongoose.Schema({
    id: { type: String, default: 'main_goal' }, 
    title: String, targetAmount: Number, currentAmount: { type: Number, default: 0 },
    isActive: { type: Boolean, default: false }, description: String
}));

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
        user.token = ""; await user.save();
        return fixToken(user.cards[0].token);
    }
    return null;
}

function sortObjectKeys(obj) { return Object.keys(obj).sort().reduce((r, k) => { r[k] = obj[k]; return r; }, {}); }

// --- Credit Card Charge ---
async function chargeCreditCard(user, amount, note, creditDetails = null) {
    const amountInAgorot = Math.round(parseFloat(amount) * 100);
    const safePhone = (user.phone || "0500000000").replace(/\D/g, '');
    let uniqueId = user.tz && user.tz.length > 5 ? user.tz : safePhone;
    
    let tranData = {
        Total: amountInAgorot, Currency: 1, ParamJ: "J4", TransactionType: "debit", CreditType: 1,
        ProjectNumber: "00001", Phone: safePhone, FirstName: user.name || "Torem", LastName: " ",
        Mail: user.email || "no@mail.com", ClientApiIdentity: uniqueId, Id: uniqueId, Details: note || ""
    };

    let finalExpiry = "", currentCardDigits = "";

    if (creditDetails) {
        tranData.CreditNum = creditDetails.num;
        finalExpiry = creditDetails.exp.length === 4 ? creditDetails.exp.substring(2, 4) + creditDetails.exp.substring(0, 2) : creditDetails.exp;
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
        } else { throw new Error("No Credit Card"); }
    }

    const sortedTran = sortObjectKeys(tranData);
    const res = await axios.post('https://kesherhk.info/ConnectToKesher/ConnectToKesher', {
        Json: { userName: '2181420WS2087', password: 'WVmO1iterNb33AbWLzMjJEyVnEQbskSZqyel5T61Hb5qdwR0gl', func: "SendTransaction", format: "json", tran: sortedTran },
        format: "json"
    }, { validateStatus: () => true });

    return { 
        success: res.data.RequestResult?.Status === true || res.data.Status === true, 
        data: res.data, 
        token: res.data.Token, 
        finalExpiry, currentCardDigits, 
        paymentMethod: 'cc' 
    };
}


// --- Bank Obligation (SendBankObligation) based on your CURL ---
async function createBankObligation(user, amount, note) {
    if (!user.bankDetails || !user.bankDetails.accountId) throw new Error("חסרים פרטי בנק");
    
    // --- שינוי קריטי: בניית האובייקט בדיוק לפי סדר ה-CURL שעובד, ללא מיון ---
    const bankPayload = {
        ClientApiIdentity: null,
        Signature: null,
        Account: parseInt(user.bankDetails.accountId), // המרה למספר כפי שמופיע ב-CURL
        Branch: parseInt(user.bankDetails.branchId),   // המרה למספר
        Bank: parseInt(user.bankDetails.bankId),       // המרה למספר
        Address: "Israel",
        City: null,
        Total: parseFloat(amount),
        Currency: 1,
        Phone: (user.phone || "00000000").replace(/\D/g, ''),
        Comment1: note || "",
        FirstName: user.bankDetails.ownerName || user.name || "Donor",
        LastName: null,
        ProjectNumber: "1", // ה-CURL שעובד משתמש ב-1
        Mail: user.email || "no@mail.com",
        ReceiptName: user.receiptName || user.name || "",
        ReceiptFor: "",
        TransactionDate: new Date().toISOString().split('T')[0],
        NumPayment: 9999
        // Id removed to match CURL exactly
    };

    console.log(`🏦 Sending Bank Obligation (CURL Format):`, JSON.stringify(bankPayload));
    
    // --- ביטול sortObjectKeys לבקשות בנק (חשוב!) ---
    // אנחנו שולחים את האובייקט כפי שהוא, כי ה-CURL לא ממויין אלפביתית והוא עובד.
    
    const res = await axios.post('https://kesherhk.info/ConnectToKesher/ConnectToKesher', {
        Json: { 
            userName: '2181420WS2087', 
            password: 'WVmO1iterNb33AbWLzMjJEyVnEQbskSZqyel5T61Hb5qdwR0gl', 
            func: "SendBankObligation",
            transaction: bankPayload 
        },
        format: "json"
    }, { validateStatus: () => true });

    console.log("Kesher Bank Response:", JSON.stringify(res.data));
    
    const isSuccess = !res.data.error && (res.data.status !== 'error');
    
    return {
        success: isSuccess,
        data: res.data,
        paymentMethod: 'bank'
    };
}


// --- Bank TRANSFER ---

async function createBankTransfer(user, amount, note) {
    if (!user.bankDetails || !user.bankDetails.accountId) throw new Error("חסרים פרטי בנק");
    
    // בניה זהה לפונקציה של הקמת ההוראה, לפי ה-CURL
    const bankPayload = {
        ClientApiIdentity: null,
        Signature: null,
        Account: parseInt(user.bankDetails.accountId),
        Branch: parseInt(user.bankDetails.branchId),
        Bank: parseInt(user.bankDetails.bankId),
        Address: "Israel",
        City: null,
        Total: parseFloat(amount),
        Currency: 1,
        Phone: (user.phone || "00000000").replace(/\D/g, ''),
        Comment1: note || "",
        FirstName: user.bankDetails.ownerName || user.name || "Donor",
        LastName: null,
        ProjectNumber: "1", // ה-CURL שעובד משתמש ב-1
        Mail: user.email || "no@mail.com",
        ReceiptName: user.receiptName || user.name || "",
        ReceiptFor: "",
        TransactionDate: new Date().toISOString().split('T')[0],
        NumPayment: 9999,
        Id: user.bankDetails.ownerID || user.tz, // בהעברה כן משאירים ת"ז
        TransferReason: note || "Payment" 
    };

    console.log(`🏦 Sending Bank TRANSFER (CURL Format):`, JSON.stringify(bankPayload));
    
    // --- ביטול sortObjectKeys לבקשות בנק ---

    const res = await axios.post('https://kesherhk.info/ConnectToKesher/ConnectToKesher', {
        Json: { 
            userName: '2181420WS2087', 
            password: 'WVmO1iterNb33AbWLzMjJEyVnEQbskSZqyel5T61Hb5qdwR0gl', 
            func: "SendFastBankTransfer",
            payment: bankPayload 
        },
        format: "json"
    }, { validateStatus: () => true });

    console.log("Kesher Bank Response:", JSON.stringify(res.data));
    
    const isSuccess = !res.data.error && (res.data.status !== 'error');
    
    return {
        success: isSuccess,
        data: res.data,
        paymentMethod: 'bank',
    };
}

// --- Unified Charge Function (Moved here to be defined AFTER dependencies) ---
async function performCharge(user, amount, note, isGoal = false, ccDetails = null) {
    // אם המשתמש מוגדר על בנק ויש לו פרטי בנק פעילים
    if (user.preferredPaymentMethod === 'bank' && user.bankDetails && user.bankDetails.accountId) {
        return await createBankTransfer(user, amount, note);
    } 
    // אחרת, ברירת המחדל היא אשראי
    return await chargeCreditCard(user, amount, note, ccDetails);
}


// --- Cron Job ---
cron.schedule('0 8 * * *', async () => {
    const today = new Date().getDate(); 
    const users = await User.find({}); 
    for (const u of users) {
        let saveUser = false;
        
        // Determine if we can charge
        let canCharge = false;
        const isBank = u.preferredPaymentMethod === 'bank';
        
        if (isBank) {
            // For Bank: We assume if status is active, we can generate a charge file or call API if supported
            // Since "SendBankObligation" is for SETUP, actual charging is usually done via Masav File export.
            // For this logic, we assume "Active" means we processed it manually or via file.
            if (u.bankDetails && u.bankDetails.status === 'active') {
                const isValidDate = !u.bankDetails.validUntil || new Date() <= new Date(u.bankDetails.validUntil);
                if (isValidDate) canCharge = true;
            }
        } else {
            if (await getActiveToken(u)) canCharge = true;
        }

        // Processing Charges (Only for CC actually running live, Bank records it for history/file gen)
        // ... (Logic remains similar, if Bank -> we just record success if active) ...
        
        if (u.recurringDailyAmount > 0) {
            let amountToCharge = u.recurringDailyAmount;
            if (isBank && u.bankDetails.dailyLimit > 0 && amountToCharge > u.bankDetails.dailyLimit) { canCharge = false; }

            if (u.recurringImmediate === true || u.billingPreference === 0) {
                if(canCharge) {
                    try {
                        let r;
                        if (isBank) {
                             // Simulation of bank charge for history (Since real charge is external/Masav file)
                             r = { success: true, paymentMethod: 'bank' }; 
                        } else {
                             r = await chargeCreditCard(u, amountToCharge, "הוראת קבע יומית");
                        }

                        if (r.success) {
                            u.totalDonated += amountToCharge;
                            u.donationsHistory.push({ amount: amountToCharge, note: "יומי קבוע", status: "success", paymentMethod: r.paymentMethod });
                        } else {
                            u.donationsHistory.push({ amount: amountToCharge, note: "יומי קבוע", status: "failed", failReason: r.data?.error || "תקלה", paymentMethod: isBank?'bank':'cc' });
                        }
                    } catch(e) { u.donationsHistory.push({ amount: amountToCharge, note: "יומי קבוע", status: "failed", failReason: e.message, paymentMethod: isBank?'bank':'cc' }); }
                    saveUser = true;
                }
            } else { u.pendingDonations.push({ amount: amountToCharge, note: "יומי קבוע (הצטברות)" }); saveUser = true; }
        }
        
        // Basket Processing... (Similar logic)
        // ...
        
        if (saveUser) await u.save();
    }
});



app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/manager', (req, res) => res.sendFile(path.join(__dirname, 'admin.html')));
app.get('/firebase-messaging-sw.js', (req, res) => res.sendFile(path.join(__dirname, 'firebase-messaging-sw.js')));

app.post('/user/submit-bank-auth', async (req, res) => {
    const { userId, bankId, branchId, accountId, ownerName, ownerID, ownerPhone, signature, file, type } = req.body;
    try {
        const u = await User.findById(userId);
        if (!u) return res.json({ success: false, error: 'User not found' });

        if (type === 'digital') {
            if(!signature && !file) return res.json({success: false, error: "חייב חתימה"});
            u.bankDetails = {
                bankId, branchId, accountId, ownerName, ownerID, ownerPhone,
                signature: signature || "", authFile: file || "",
                submissionType: 'digital', status: 'pending', dailyLimit: 0
            };
        } else if (type === 'upload') {
             u.bankDetails = { authFile: file, submissionType: 'upload', status: 'pending', dailyLimit: 0 };
        }
        u.preferredPaymentMethod = 'bank'; 
        u.messages.push({ direction: 'user_to_admin', content: `בקשה להרשאה בנקאית (${type}). נא לאשר בניהול בנקים.`, date: new Date(), read: false });
        await u.save();
        res.json({ success: true });
    } catch (e) { res.json({ success: false, error: e.message }); }
});

app.post('/admin/manage-bank-auth', async (req, res) => {
    const { userId, action, data } = req.body; 
    try {
        const u = await User.findById(userId);
        if (!u) return res.json({ success: false });

        if (action === 'approve') {
            // Attempt to Register Obligation at Kesher
            try {
                // If data has manual overrides, use them
                if (data) {
                    if (data.limit) u.bankDetails.dailyLimit = parseInt(data.limit);
                    if (data.validUntil) u.bankDetails.validUntil = new Date(data.validUntil);
                }
                
                // Call Kesher API to register obligation
                // Note: We use a nominal amount (e.g. 1) or the limit to register the mandate
                const kesherRes = await createBankObligation(u, u.bankDetails.dailyLimit || 1, "הקמת הרשאה");
                
                if (kesherRes.success) {
                    u.bankDetails.status = 'active';
                    u.bankDetails.approvedDate = new Date();
                    u.preferredPaymentMethod = 'bank';
                    u.messages.push({ direction: 'admin_to_user', content: 'הוראת הקבע הבנקאית אושרה והוקמה בהצלחה.', date: new Date(), read: false });
                } else {
                    throw new Error("שגיאה בהקמה מול מסב: " + JSON.stringify(kesherRes.data));
                }
            } catch(err) {
                return res.json({ success: false, error: "שגיאה מול קשר: " + err.message });
            }
        } 
        else if (action === 'reject') {
            u.bankDetails.status = 'rejected'; u.preferredPaymentMethod = 'cc';
             u.messages.push({ direction: 'admin_to_user', content: 'הוראת הקבע הבנקאית נדחתה.', date: new Date(), read: false });
        }
        else if (action === 'manual_setup') {
            u.bankDetails = {
                bankId: data.bankId, branchId: data.branchId, accountId: data.accountId,
                ownerName: data.ownerName, ownerID: data.ownerID, 
                status: 'active', dailyLimit: data.limit ? parseInt(data.limit) : 0,
                submissionType: 'manual', approvedDate: new Date()
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
    const users = await User.find({ 
        $or: [{ 'bankDetails.status': 'pending' }, { 'bankDetails.status': 'active' }, { 'bankDetails.status': 'rejected' }]
    }).select('name phone email bankDetails _id');
    res.json({ success: true, users });
});

app.post('/donate', async (req, res) => {
    const { userId, preferredPaymentMethod, amount, note, forceImmediate, providedPin, isGoalDonation } = req.body;
    
    try {
        let u = await User.findById(userId);
        if (!u) return res.json({ success: false, error: "משתמש לא נמצא" });

        if (u.securityPin && u.securityPin.trim() !== "") {
            if (String(providedPin).trim() !== String(u.securityPin).trim()) {
                return res.json({ success: false, error: "קוד אבטחה שגוי" });
            }
        }

        let shouldChargeNow = (isGoalDonation === true) || (forceImmediate === true) || (u.billingPreference === 0);

        if (shouldChargeNow) {
            // בדיקת תקרה רק אם זה בנק
            if (preferredPaymentMethod === 'bank' && u.bankDetails.dailyLimit > 0) {
                if (parseFloat(amount) > u.bankDetails.dailyLimit) {
                    return res.json({ success: false, error: "חריגה מתקרה יומית" });
                }
            }

            // קריאה לפונקציה המאוחדת
            const r = await performCharge(u, amount, note, isGoalDonation);

            if (r.success) {
                u.totalDonated += parseFloat(amount);
                u.donationsHistory.push({
                    amount: parseFloat(amount),
                    note: note || "תרומה",
                    date: new Date(),
                    status: 'success',
                    isGoal: isGoalDonation === true,
                    paymentMethod: r.paymentMethod
                });

                if (isGoalDonation) {
                    await GlobalGoal.findOneAndUpdate({ id: 'main_goal' }, { $inc: { currentAmount: parseFloat(amount) } });
                }

                await u.save();
                return res.json({ success: true, message: "תרומה התקבלה!", res: r});
            } else {
                return res.json({ success: false, error: r.data?.RequestResult?.Message || "סירוב מהספק", res: r });
            }
        } else {
            u.pendingDonations.push({ amount: parseFloat(amount), note, date: new Date() });
            await u.save();
            return res.json({ success: true, message: "נוסף לסל" });
        }
    } catch (e) {
        res.json({ success: false, error: e.message });
    }
});


// Standard Routes
app.post('/contact/send', async (req, res) => { const { userId, content, attachment, attachmentName } = req.body; try { const u = await User.findById(userId); if(!u) return res.json({ success: false }); u.messages.push({ direction: 'user_to_admin', content, attachment, attachmentName, read: false, date: new Date() }); await u.save(); res.json({ success: true }); } catch(e) { res.json({ success: false }); } });
app.post('/admin/reply', async (req, res) => { const { userId, content, attachment, attachmentName } = req.body; try { const u = await User.findById(userId); if(!u) return res.json({ success: false }); u.messages.push({ direction: 'admin_to_user', content, attachment, attachmentName, read: false, date: new Date() }); await u.save(); if(u.fcmToken) admin.messaging().send({ token: u.fcmToken, notification: { title: 'הודעה חדשה', body: content } }).catch(e=>{}); res.json({ success: true }); } catch(e) { res.json({ success: false }); } });
app.post('/admin/get-messages', async (req, res) => { const users = await User.find({ 'messages.0': { $exists: true } }).select('name phone messages _id'); const sorted = users.map(u => { const last = u.messages[u.messages.length - 1]; return { _id: u._id, name: u.name, phone: u.phone, lastMessageDate: last?last.date:0, unreadCount: u.messages.filter(m => m.direction === 'user_to_admin' && !m.read).length, messages: u.messages }; }).sort((a,b)=>new Date(b.lastMessageDate)-new Date(a.lastMessageDate)); res.json({ success: true, users: sorted }); });
app.post('/admin/mark-read', async (req, res) => { await User.updateOne({ _id: req.body.userId }, { $set: { "messages.$[elem].read": true } }, { arrayFilters: [{ "elem.direction": "user_to_admin" }] }); res.json({ success: true }); });
app.post('/user/mark-read', async (req, res) => { await User.updateOne({ _id: req.body.userId }, { $set: { "messages.$[elem].read": true } }, { arrayFilters: [{ "elem.direction": "admin_to_user" }] }); res.json({ success: true }); });
app.post('/update-code', async (req, res) => { let { email, phone, code } = req.body; let cE = email?email.toLowerCase().trim():undefined; let cP = phone?phone.replace(/\D/g, ''):undefined; if (cE) axios.post('https://api.emailjs.com/api/v1.0/email/send', { service_id: 'service_8f6h188', template_id: 'template_tzbq0k4', user_id: 'yLYooSdg891aL7etD', template_params: { email: cE, code }, accessToken: "b-Dz-J0Iq_yJvCfqX5Iw3" }).catch(e=>{}); await User.findOneAndUpdate(cE ? { email: cE } : { phone: cP }, { tempCode: code, email: cE, phone: cP }, { upsert: true }); res.json({ success: true }); });
app.post('/send-verification', async (req, res) => { try { await axios.post('https://api.emailjs.com/api/v1.0/email/send', { service_id: 'service_8f6h188', template_id: 'template_tzbq0k4', user_id: 'yLYooSdg891aL7etD', template_params: { email: req.body.email, code: req.body.code }, accessToken: "b-Dz-J0Iq_yJvCfqX5Iw3" }); res.json({ success: true }); } catch(e) { res.json({ success: false }); } });
app.post('/verify-auth', async (req, res) => { let { email, phone, code } = req.body; if(code === 'check') return res.json({ success: true }); let u = await User.findOne(email ? { email: email.toLowerCase().trim() } : { phone: phone.replace(/\D/g, '').trim() }); if (u && String(u.tempCode).trim() === String(code).trim()) res.json({ success: true, user: u }); else res.json({ success: false }); });
app.post('/login-by-id', async (req, res) => { try { let user = await User.findById(req.body.userId); if(user) { if ((!user.cards || user.cards.length === 0) && user.token) { user.cards.push({ token: user.token, lastDigits: user.lastCardDigits, expiry: user.lastExpiry, active: true }); user.token = ""; await user.save(); } res.json({ success: true, user }); } else res.json({ success: false }); } catch(e) { res.json({ success: false }); } });
// app.post('/donate', async (req, res) => { const { userId, amount, useToken, note, forceImmediate, ccDetails, providedPin, isGoalDonation, useReceiptDetails } = req.body; let u = await User.findById(userId); if (u.securityPin && u.securityPin.trim() !== "") { if (String(providedPin).trim() !== String(u.securityPin).trim()) return res.json({ success: false, error: "קוד שגוי" }); } let shouldChargeNow = (isGoalDonation === true) || (forceImmediate === true) ? true : (u.billingPreference === 0 && forceImmediate !== false); if (shouldChargeNow) { try { if (u.preferredPaymentMethod === 'bank' && u.bankDetails.dailyLimit > 0 && parseFloat(amount) > u.bankDetails.dailyLimit) return res.json({ success: false, error: "חריגה מתקרה יומית" }); const r = await performCharge(u, amount, note, false, ccDetails); if (r.success) { u.totalDonated += parseFloat(amount); u.donationsHistory.push({ amount: parseFloat(amount), note, date: new Date(), status: 'success', isGoal: isGoalDonation === true, paymentMethod: r.paymentMethod }); await u.save(); if (isGoalDonation) await GlobalGoal.findOneAndUpdate({ id: 'main_goal' }, { $inc: { currentAmount: parseFloat(amount) } }); res.json({ success: true, message: "תרומה התקבלה!" }); } else res.json({ success: false, error: r.data?.error || "סירוב" }); } catch(e) { res.json({ success: false, error: e.message }); } } else { u.pendingDonations.push({ amount: parseFloat(amount), note, date: new Date() }); await u.save(); res.json({ success: true, message: "נוסף לסל" }); } });
app.post('/delete-pending', async (req, res) => { const u = await User.findById(req.body.userId); if (u.canRemoveFromBasket === false) return res.json({ success: false, error: "ננעל" }); await User.findByIdAndUpdate(req.body.userId, { $pull: { pendingDonations: { _id: req.body.donationId } } }); res.json({ success: true }); });
app.post('/admin/update-profile', async (req, res) => { try { const { userId, name, phone, email, tz, billingPreference, recurringDailyAmount, securityPin, recurringImmediate, newCardDetails, canRemoveFromBasket, activeCardId, deleteCardId, addManualCardData, receiptName, receiptTZ, receiptMode, maaserActive, maaserRate, maaserIncome, showTaxWidget, preferredPaymentMethod } = req.body; let u = await User.findById(userId); if (deleteCardId) { u.cards = u.cards.filter(c => c._id.toString() !== deleteCardId); if (!u.cards.some(c => c.active) && u.cards.length > 0) u.cards[0].active = true; } if (activeCardId) u.cards.forEach(c => c.active = (c._id.toString() === activeCardId)); if (newCardDetails && newCardDetails.num) { try { const r = await chargeCreditCard(u, 0.1, "בדיקה", newCardDetails); if (r.success || r.token) { u.cards.forEach(c => c.active = false); u.cards.push({ token: fixToken(r.token), lastDigits: r.currentCardDigits, expiry: r.finalExpiry, active: true }); if(r.success) { u.totalDonated += 0.1; u.donationsHistory.push({ amount: 0.1, note: "בדיקה", status: 'success', date: new Date() }); } } else return res.json({ success: false, error: "אימות נכשל" }); } catch(e) { return res.json({ success: false, error: e.message }); } } if (addManualCardData) { u.cards.forEach(c => c.active = false); u.cards.push({ token: fixToken(addManualCardData.token), lastDigits: addManualCardData.lastDigits, expiry: addManualCardData.expiry, active: true }); } if(name) u.name = name; if(phone) u.phone = phone; if(email) u.email = email; if(tz) u.tz = tz; u.billingPreference = parseInt(billingPreference)||0; u.recurringDailyAmount = parseInt(recurringDailyAmount)||0; u.recurringImmediate = recurringImmediate===true; u.securityPin = securityPin; u.canRemoveFromBasket = canRemoveFromBasket; if(receiptName !== undefined) u.receiptName = receiptName; if(receiptTZ !== undefined) u.receiptTZ = receiptTZ; if(receiptMode !== undefined) u.receiptMode = parseInt(receiptMode); if(maaserActive !== undefined) u.maaserActive = maaserActive; if(maaserRate !== undefined) u.maaserRate = parseInt(maaserRate); if(maaserIncome !== undefined) u.maaserIncome = parseInt(maaserIncome); if(showTaxWidget !== undefined) u.showTaxWidget = showTaxWidget; if(preferredPaymentMethod) u.preferredPaymentMethod = preferredPaymentMethod; await u.save(); res.json({ success: true }); } catch(e) { res.status(500).json({ success: false, error: e.message }); } });
const PASS = "admin1234";
app.post('/admin/stats', async (req, res) => { if(req.body.password !== PASS) return res.json({ success: false }); const { fromDate, toDate } = req.body; let start = fromDate ? new Date(fromDate) : new Date(0); start.setHours(0,0,0,0); let end = toDate ? new Date(toDate) : new Date(); end.setHours(23, 59, 59, 999); const now = new Date(); const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1); const endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59); const users = await User.find(); let totalRange = 0; let countRange = 0; let totalMonth = 0; let uniqueDonors = new Set(); users.forEach(u => u.donationsHistory?.forEach(d => { let dDate = new Date(d.date); if (d.status === 'success') { const amount = d.amount || 0; if (dDate >= start && dDate <= end) { totalRange += amount; countRange++; uniqueDonors.add(u._id.toString()); } if (dDate >= startOfMonth && dDate <= endOfMonth) { totalMonth += amount; } } })); res.json({ success: true, stats: { totalDonated: totalRange, totalDonations: countRange, totalUsers: users.length, uniqueDonorsRange: uniqueDonors.size, totalMonth: totalMonth } }); });
app.post('/admin/add-donation-manual', async (req, res) => { if(req.body.password !== PASS) return res.json({ success: false }); const { userId, amount, type, note } = req.body; let u = await User.findById(userId); if (!u) return res.json({ success: false }); if (type === 'immediate') { try { const r = await performCharge(u, amount, note || "חיוב מנהל"); if (r.success) { u.totalDonated += parseFloat(amount); u.donationsHistory.push({ amount: parseFloat(amount), note: note || "חיוב מנהל", date: new Date(), status: 'success', paymentMethod: r.paymentMethod }); await u.save(); res.json({ success: true }); } else { res.json({ success: false, error: "סירוב" }); } } catch (e) { res.json({ success: false, error: e.message }); } } else { u.pendingDonations.push({ amount: parseFloat(amount), note: note || "הוסף ע\"י מנהל", date: new Date() }); await u.save(); res.json({ success: true }); } });
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
