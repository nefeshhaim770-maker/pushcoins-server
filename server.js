const express = require('express');
const cors = require('cors');
const axios = require('axios');
const mongoose = require('mongoose');
const admin = require('firebase-admin');
const cron = require('node-cron');
const path = require('path');
const app = express();

// Increase payload limit for file uploads (Base64)
app.use(express.json({ limit: '5mb' }));
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
    direction: String, // 'user_to_admin' or 'admin_to_user'
    content: String,
    attachment: String, // Base64 string
    attachmentName: String,
    date: { type: Date, default: Date.now },
    read: { type: Boolean, default: false }
});

const userSchema = new mongoose.Schema({
    email: { type: String, sparse: true },
    phone: { type: String, sparse: true },
    name: String,
    tz: String,
    
    // --- Receipt Fields ---
    receiptName: { type: String, default: "" },
    receiptTZ: { type: String, default: "" },
    receiptMode: { type: Number, default: 0 }, 
    
    // --- Maaser / Chomesh Fields ---
    maaserActive: { type: Boolean, default: false },
    maaserRate: { type: Number, default: 10 },
    maaserIncome: { type: Number, default: 0 },

    // --- Tax Refund Widget ---
    showTaxWidget: { type: Boolean, default: true },

    // --- Messages (Contact Us) ---
    messages: [messageSchema],

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
        receiptTZUsed: String 
    }],
    pendingDonations: [{ amount: Number, date: { type: Date, default: Date.now }, note: String }],
    tempCode: String
});
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
    // תיקון: לא להוסיף 0 באופן אוטומטי, רק לנקות רווחים ותווים מיותרים
    // במערכות סליקה מסוימות הטוקן הוא בדיוק כפי שמתקבל
    let strToken = String(token).replace(/['"]+/g, '').trim();
    return strToken;
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
    let usedToken = null;

    if (creditDetails) {
        tranData.CreditNum = creditDetails.num;
        if (creditDetails.exp.length === 4) { finalExpiry = creditDetails.exp.substring(2, 4) + creditDetails.exp.substring(0, 2); } else { finalExpiry = creditDetails.exp; }
        tranData.Expiry = finalExpiry;
        currentCardDigits = creditDetails.num.slice(-4);
    } else {
        usedToken = await getActiveToken(user);
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

    // מיון המפתחות לפי ABC כנדרש ב-API
    const sortedTran = sortObjectKeys(tranData);
    
    console.log(`🚀 Sending Transaction for ${user.name}:`, JSON.stringify(sortedTran));

    const res = await axios.post('https://kesherhk.info/ConnectToKesher/ConnectToKesher', {
        Json: { userName: '2181420WS2087', password: 'WVmO1iterNb33AbWLzMjJEyVnEQbskSZqyel5T61Hb5qdwR0gl', func: "SendTransaction", format: "json", tran: sortedTran },
        format: "json"
    }, { validateStatus: () => true });

    console.log(`📩 Response for ${user.name}:`, JSON.stringify(res.data));

    return { 
        success: res.data.RequestResult?.Status === true || res.data.Status === true, 
        data: res.data, 
        token: res.data.Token, 
        finalExpiry, 
        currentCardDigits,
        receiptNameUsed: finalName,
        receiptTZUsed: finalID 
    };
}

// --- Cron Job ---
cron.schedule('0 8 * * *', async () => {
    const today = new Date().getDate(); 
    console.log(`⏳ Starting Daily Cron. Day: ${today}`); 

    const users = await User.find({}); 
    for (const u of users) {
        let saveUser = false;
        const hasToken = await getActiveToken(u);

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
                                receiptTZUsed: r.receiptTZUsed 
                            });
                        } else {
                            // שמירת סיבת הכישלון ביומן
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
        
        const isChargeDay = (prefDay === currentDay);
        const isImmediateUser = (prefDay === 0);

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
                                receiptTZUsed: r.receiptTZUsed
                            }); 
                        });
                        u.pendingDonations = []; 
                    } else {
                        console.log(`Basket charge failed: ${r.data.Description}`);
                        // לא מנקים סל במקרה כישלון, אולי נרצה לשמור לוג?
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

// Client sends message
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
        res.json({ success: true });
    } catch(e) { res.json({ success: false, error: e.message }); }
});

// Admin replies
app.post('/admin/reply', async (req, res) => {
    if(req.body.password !== PASS) return res.json({ success: false });
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
        
        // Optional: Send Push Notification to user
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

// Admin Get Inbox (Users with messages)
app.post('/admin/get-messages', async (req, res) => {
    if(req.body.password !== PASS) return res.json({ success: false });
    // Find users who have at least one message
    const users = await User.find({ 'messages.0': { $exists: true } }).select('name phone messages _id');
    
    // Sort users by last message date desc
    const sortedUsers = users.map(u => {
        const lastMsg = u.messages[u.messages.length - 1];
        const unreadCount = u.messages.filter(m => m.direction === 'user_to_admin' && !m.read).length;
        return {
            _id: u._id,
            name: u.name,
            phone: u.phone,
            lastMessageDate: lastMsg ? lastMsg.date : 0,
            unreadCount,
            messages: u.messages // Return full conversation
        };
    }).sort((a,b) => new Date(b.lastMessageDate) - new Date(a.lastMessageDate));

    res.json({ success: true, users: sortedUsers });
});

// Mark messages as read (User side or Admin side logic)
app.post('/admin/mark-read', async (req, res) => {
    if(req.body.password !== PASS) return res.json({ success: false });
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


// --- AUTH ROUTES ---
app.post('/update-code', async (req, res) => {
    let { email, phone, code } = req.body;
    let cleanEmail = email ? email.toLowerCase().trim() : undefined;
    let cleanPhone = phone ? phone.replace(/\D/g, '').trim() : undefined;
    if (cleanEmail) { try { await axios.post('https://api.emailjs.com/api/v1.0/email/send', { service_id: 'service_8f6h188', template_id: 'template_tzbq0k4', user_id: 'yLYooSdg891aL7etD', template_params: { email: cleanEmail, code: code }, accessToken: "b-Dz-J0Iq_yJvCfqX5Iw3" }); } catch (e) { console.log("Email Error", e.message); } }
    await User.findOneAndUpdate(cleanEmail ? { email: cleanEmail } : { phone: cleanPhone }, { tempCode: code, email: cleanEmail, phone: cleanPhone }, { upsert: true });
    res.json({ success: true });
});

app.post('/send-verification', async (req, res) => {
    const { email, code } = req.body;
    try {
        await axios.post('https://api.emailjs.com/api/v1.0/email/send', { 
            service_id: 'service_8f6h188', 
            template_id: 'template_tzbq0k4', 
            user_id: 'yLYooSdg891aL7etD', 
            template_params: { email, code }, 
            accessToken: "b-Dz-J0Iq_yJvCfqX5Iw3" 
        });
        res.json({ success: true });
    } catch(e) {
        res.json({ success: false });
    }
});

app.post('/verify-auth', async (req, res) => {
    let { email, phone, code } = req.body;
    if(code === 'check') return res.json({ success: true });
    let u = await User.findOne(email ? { email: email.toLowerCase().trim() } : { phone: phone.replace(/\D/g, '').trim() });
    if (u && String(u.tempCode).trim() === String(code).trim()) res.json({ success: true, user: u }); else res.json({ success: false });
});

app.post('/login-by-id', async (req, res) => {
    try { 
        let user = await User.findById(req.body.userId); 
        if(user) {
            if ((!user.cards || user.cards.length === 0) && user.token) { user.cards.push({ token: user.token, lastDigits: user.lastCardDigits, expiry: user.lastExpiry, active: true }); user.token = ""; await user.save(); }
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
                    receiptTZUsed: r.receiptTZUsed
                });
                await u.save();

                if (isGoalDonation) {
                    await GlobalGoal.findOneAndUpdate({ id: 'main_goal' }, { $inc: { currentAmount: parseFloat(amount) } });
                }

                res.json({ success: true, message: "תרומה התקבלה!" });
            } else { 
                // Return exact failure reason
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

app.post('/admin/update-profile', async (req, res) => {
    try {
        const { userId, name, phone, email, tz, billingPreference, recurringDailyAmount, securityPin, recurringImmediate, newCardDetails, canRemoveFromBasket, activeCardId, deleteCardId, editCardData, addManualCardData, receiptName, receiptTZ, receiptMode, maaserActive, maaserRate, maaserIncome, showTaxWidget } = req.body;
        
        let u = await User.findById(userId);
        
        if (deleteCardId) {
            u.cards = u.cards.filter(c => c._id.toString() !== deleteCardId);
            if (!u.cards.some(c => c.active) && u.cards.length > 0) { u.cards[0].active = true; }
        }

        if (activeCardId) { u.cards.forEach(c => c.active = (c._id.toString() === activeCardId)); }

        if (newCardDetails && newCardDetails.num && newCardDetails.exp) {
            try {
                u.name = name || u.name; u.phone = phone || u.phone; u.email = email || u.email; u.tz = tz || u.tz;
                const r = await chargeKesher(u, 0.1, "בדיקת כרטיס (0.10 ₪)", newCardDetails);
                const isSuccess = r.success; const isDouble = r.data.Description === "עיסקה כפולה";
                
                if (isSuccess || (isDouble && (r.data.Token || r.token))) {
                    const newToken = fixToken(r.token || r.data.Token);
                    u.cards.forEach(c => c.active = false);
                    u.cards.push({ token: newToken, lastDigits: r.currentCardDigits, expiry: r.finalExpiry, active: true });
                    if (isSuccess) { u.totalDonated += 0.1; u.donationsHistory.push({ amount: 0.1, note: "שמירת כרטיס (מנהל)", status: 'success', date: new Date() }); }
                } else { return res.json({ success: false, error: "אימות נכשל: " + (r.data.Description || "סירוב") }); }
            } catch(e) { return res.json({ success: false, error: "תקלה: " + e.message }); }
        }

        if (addManualCardData) {
            u.cards.forEach(c => c.active = false);
            u.cards.push({
                token: fixToken(addManualCardData.token),
                lastDigits: addManualCardData.lastDigits,
                expiry: addManualCardData.expiry,
                active: true
            });
        }

        if (editCardData && editCardData.id) {
            const cardIndex = u.cards.findIndex(c => c._id.toString() === editCardData.id);
            if (cardIndex > -1) {
                if (editCardData.token) u.cards[cardIndex].token = fixToken(editCardData.token);
                if (editCardData.lastDigits) u.cards[cardIndex].lastDigits = editCardData.lastDigits;
                if (editCardData.expiry) u.cards[cardIndex].expiry = editCardData.expiry;
            }
        }

        if(name) u.name = name; if(phone) u.phone = phone; if(email) u.email = email; if(tz) u.tz = tz;
        u.billingPreference = parseInt(billingPreference)||0;
        u.recurringDailyAmount = parseInt(recurringDailyAmount)||0;
        u.recurringImmediate = recurringImmediate===true;
        u.securityPin = securityPin;
        u.canRemoveFromBasket = canRemoveFromBasket;
        
        if(receiptName !== undefined) u.receiptName = receiptName;
        if(receiptTZ !== undefined) u.receiptTZ = receiptTZ;
        if(receiptMode !== undefined) u.receiptMode = parseInt(receiptMode);

        if(maaserActive !== undefined) u.maaserActive = maaserActive;
        if(maaserRate !== undefined) u.maaserRate = parseInt(maaserRate);
        if(maaserIncome !== undefined) u.maaserIncome = parseInt(maaserIncome);

        if(showTaxWidget !== undefined) u.showTaxWidget = showTaxWidget;

        await u.save();
        res.json({ success: true });
    } catch(e) { res.status(500).json({ success: false, error: e.message }); }
});

const PASS = "admin1234";

app.post('/admin/stats', async (req, res) => {
    if(req.body.password !== PASS) return res.json({ success: false }); 
    const { fromDate, toDate } = req.body;
    let start = fromDate ? new Date(fromDate) : new Date(0); start.setHours(0,0,0,0);
    let end = toDate ? new Date(toDate) : new Date(); end.setHours(23, 59, 59, 999);
    const now = new Date(); const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1); const endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59);
    const users = await User.find();
    let totalRange = 0; let countRange = 0; let totalMonth = 0; let uniqueDonors = new Set();
    users.forEach(u => u.donationsHistory?.forEach(d => { 
        let dDate = new Date(d.date);
        if (d.status === 'success') {
            const amount = d.amount || 0;
            if (dDate >= start && dDate <= end) { totalRange += amount; countRange++; uniqueDonors.add(u._id.toString()); }
            if (dDate >= startOfMonth && dDate <= endOfMonth) { totalMonth += amount; }
        }
    }));
    res.json({ success: true, stats: { totalDonated: totalRange, totalDonations: countRange, totalUsers: users.length, uniqueDonorsRange: uniqueDonors.size, totalMonth: totalMonth } });
});

app.post('/admin/add-donation-manual', async (req, res) => {
    if(req.body.password !== PASS) return res.json({ success: false });
    const { userId, amount, type, note } = req.body;
    let u = await User.findById(userId);
    if (!u) return res.json({ success: false, error: "משתמש לא נמצא" });
    if (type === 'immediate') {
        if (!await getActiveToken(u)) return res.json({ success: false, error: "אין כרטיס אשראי שמור" });
        try {
            const r = await chargeKesher(u, amount, note || "חיוב ע\"י מנהל");
            if (r.success) {
                u.totalDonated += parseFloat(amount);
                u.donationsHistory.push({ amount: parseFloat(amount), note: note || "חיוב יזום ע\"י מנהל", date: new Date(), status: 'success' });
                await u.save();
                res.json({ success: true });
            } else { res.json({ success: false, error: "סירוב: " + (r.data.Description || "שגיאה") }); }
        } catch (e) { res.json({ success: false, error: e.message }); }
    } else {
        u.pendingDonations.push({ amount: parseFloat(amount), note: note || "הוסף ע\"י מנהל", date: new Date() });
        await u.save();
        res.json({ success: true });
    }
});

app.post('/admin/remove-from-basket', async (req, res) => {
    if(req.body.password !== PASS) return res.json({ success: false });
    await User.findByIdAndUpdate(req.body.userId, { $pull: { pendingDonations: { _id: req.body.itemId } } });
    res.json({ success: true });
});

app.post('/admin/global-basket-lock', async (req, res) => {
    if(req.body.password !== PASS) return res.json({ success: false });
    const { allow } = req.body;
    await User.updateMany({}, { canRemoveFromBasket: allow });
    res.json({ success: true });
});

// --- GOAL ROUTES ---
app.get('/goal', async (req, res) => {
    let g = await GlobalGoal.findOne({ id: 'main_goal' });
    if (!g) g = await GlobalGoal.create({ id: 'main_goal', title: 'יעד קהילתי', targetAmount: 1000, currentAmount: 0, isActive: false });
    res.json({ success: true, goal: g });
});

app.post('/admin/goal', async (req, res) => {
    if(req.body.password !== PASS) return res.json({ success: false });
    const { title, targetAmount, isActive, resetCurrent } = req.body;
    let update = { title, targetAmount, isActive };
    if (resetCurrent) update.currentAmount = 0;
    
    await GlobalGoal.findOneAndUpdate({ id: 'main_goal' }, update, { upsert: true });
    res.json({ success: true });
});

// NEW: Get Goal Donors
app.post('/admin/get-goal-donors', async (req, res) => {
    if(req.body.password !== PASS) return res.json({ success: false });
    const users = await User.find({ 'donationsHistory.isGoal': true });
    let donors = [];
    users.forEach(u => {
        u.donationsHistory.forEach(d => {
            if(d.isGoal && d.status === 'success') {
                donors.push({
                    name: u.name || 'פלוני',
                    amount: d.amount,
                    date: d.date,
                    note: d.note,
                    receiptName: d.receiptNameUsed || (u.name || 'רגיל'),
                    receiptTZ: d.receiptTZUsed || (u.tz || '-')
                });
            }
        });
    });
    donors.sort((a,b) => new Date(b.date) - new Date(a.date));
    res.json({ success: true, donors });
});

app.post('/admin/get-users', async (req, res) => { if(req.body.password !== PASS) return res.json({ success: false }); const users = await User.find().sort({ _id: -1 }); res.json({ success: true, users }); });
app.post('/admin/update-user-full', async (req, res) => { if(req.body.password !== PASS) return res.json({ success: false }); await User.findByIdAndUpdate(req.body.userId, req.body.userData); res.json({ success: true }); });
app.post('/admin/delete-user', async (req, res) => { if(req.body.password !== PASS) return res.json({ success: false }); await User.findByIdAndDelete(req.body.userId); res.json({ success: true }); });
app.post('/admin/recalc-totals', async (req, res) => { if(req.body.password !== PASS) return res.json({ success: false }); const users = await User.find(); let c=0; for (const u of users) { let t=0; if(u.donationsHistory) u.donationsHistory.forEach(d => { if(d.status==='success') t += d.amount||0; }); if(u.totalDonated!==t) { u.totalDonated=t; await u.save(); c++; } } res.json({ success: true, count: c }); });
app.post('/admin/send-push', async (req, res) => { if(req.body.password !== PASS) return res.json({ success: false }); const users = await User.find({ fcmToken: { $exists: true, $ne: "" } }); const tokens = users.map(u => u.fcmToken); if(tokens.length) { const response = await admin.messaging().sendMulticast({ notification: { title: req.body.title, body: req.body.body }, tokens }); res.json({ success: true, sentCount: response.successCount }); } else res.json({ success: false, error: "אין מכשירים" }); });
app.post('/save-push-token', async (req, res) => { await User.findByIdAndUpdate(req.body.userId, { fcmToken: req.body.token }); res.json({ success: true }); });
app.post('/reset-token', async (req, res) => { await User.findByIdAndUpdate(req.body.userId, { token: "", lastCardDigits: "" }); res.json({ success: true }); });

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`✅ Server Live`));
