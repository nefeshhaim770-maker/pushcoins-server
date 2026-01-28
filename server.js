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
        paymentMethod: String, receiptNameUsed: String, receiptTZUsed: String,
        receiptUrl: String
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

// --- Helper: Fetch Receipt Details (GetTranData) ---
async function getReceiptFromKesher(transactionNum) {
    if (!transactionNum) return null;
    try {
        console.log(`🔍 Fetching Receipt for Transaction ID: ${transactionNum}`);
        const res = await axios.post('https://kesherhk.info/ConnectToKesher/ConnectToKesher', {
            Json: {
                userName: '2181420WS2087',
                password: 'WVmO1iterNb33AbWLzMjJEyVnEQbskSZqyel5T61Hb5qdwR0gl',
                func: "GetTranData",
                transactionNum: String(transactionNum)
            },
            format: "json"
        }, { validateStatus: () => true });

        // Log the RAW response from GetTranData to debug issues
        console.log(`🧾 GetTranData Response for ${transactionNum}:`, JSON.stringify(res.data));

        if (!res.data) {
            console.log("⚠️ Receipt API returned empty data");
            return null;
        }

        // Try to extract PDF link
        let link = res.data.CopyDoc || res.data.OriginalDoc || null;
        if (!link && res.data.DocumentsDetails && res.data.DocumentsDetails.DocumentDetails && res.data.DocumentsDetails.DocumentDetails.length > 0) {
            link = res.data.DocumentsDetails.DocumentDetails[0].PdfLinkCopy || res.data.DocumentsDetails.DocumentDetails[0].PdfLink;
        }
        
        if (link) console.log("✅ Receipt Link Found:", link);
        else console.log("❌ No Receipt Link in GetTranData response");

        return link;
    } catch (e) {
        console.error("❌ Error fetching receipt:", e.message);
        return null;
    }
}

// --- Credit Card Charge ---
async function chargeCreditCard(user, amount, note, creditDetails = null) {
    const amountInAgorot = Math.round(parseFloat(amount) * 100);
    const safePhone = (user.phone || "0500000000").replace(/\D/g, '');
    let uniqueId = user.tz && user.tz.length > 5 ? user.tz : safePhone;
    
    // Receipt Info Logic
    const receiptName = user.receiptName || user.name || "Torem";
    const receiptTZ = user.receiptTZ || uniqueId;

    let tranData = {
        Total: amountInAgorot, Currency: 1, ParamJ: "J4", TransactionType: "debit", CreditType: 1,
        ProjectNumber: "00001", Phone: safePhone, FirstName: user.name || "Torem", LastName: " ",
        Mail: user.email || "no@mail.com", ClientApiIdentity: uniqueId, Id: uniqueId, 
        Details: "", // Always empty per request
        ReceiptName: receiptName
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
        } else { throw new Error("No Credit Card Found"); }
    }

    const sortedTran = sortObjectKeys(tranData);
    console.log(`🚀 Sending CC Charge for ${user.name}:`, JSON.stringify(sortedTran));

    const res = await axios.post('https://kesherhk.info/ConnectToKesher/ConnectToKesher', {
        Json: { userName: '2181420WS2087', password: 'WVmO1iterNb33AbWLzMjJEyVnEQbskSZqyel5T61Hb5qdwR0gl', func: "SendTransaction", format: "json", tran: sortedTran },
        format: "json"
    }, { validateStatus: () => true });

    console.log(`📩 CC Response:`, JSON.stringify(res.data));

    const isSuccess = res.data.RequestResult?.Status === true || res.data.Status === true;

    // Identify Transaction ID
    // We try to grab the best ID available. NumTransaction is often the only one available in basic plans.
    const transId = res.data.RequestResult?.TransactionId || res.data.TransactionId || res.data.NumTransaction;
    
    console.log(`🔑 Detected Transaction ID for Receipt Fetch: ${transId}`); // Log what ID we are using

    let receiptUrl = res.data.CopyDoc || res.data.OriginalDoc || null;
    if (!receiptUrl && res.data.DocumentsDetails && res.data.DocumentsDetails.DocumentDetails && res.data.DocumentsDetails.DocumentDetails.length > 0) {
        receiptUrl = res.data.DocumentsDetails.DocumentDetails[0].PdfLinkCopy || res.data.DocumentsDetails.DocumentDetails[0].PdfLink;
    }

    // Explicit request: Call GetTranData to ensure receipt is fetched
    if (isSuccess && transId) {
        const extraReceiptUrl = await getReceiptFromKesher(transId);
        if (extraReceiptUrl) receiptUrl = extraReceiptUrl;
    }

    return { 
        success: isSuccess, 
        data: res.data, 
        token: res.data.Token, 
        finalExpiry, currentCardDigits, 
        paymentMethod: 'cc',
        receiptUrl: receiptUrl,
        receiptNameUsed: receiptName, 
        receiptTZUsed: receiptTZ      
    };
}

// --- Bank Obligation ---
async function createBankObligation(user, amount, note) {
    if (!user.bankDetails || !user.bankDetails.accountId) throw new Error("חסרים פרטי בנק");
    
    const receiptName = user.receiptName || user.name || "Donor";

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
        ProjectNumber: "1",
        Mail: user.email || "no@mail.com",
        ReceiptName: receiptName, 
        ReceiptFor: "",
        TransactionDate: new Date().toISOString().split('T')[0],
        NumPayment: 9999 
    };

    console.log(`🏦 Sending Bank Obligation:`, JSON.stringify(bankPayload));

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
    
    // Identify Transaction ID
    const transId = res.data.RequestResult?.TransactionId || res.data.TransactionId || res.data.NumTransaction;

    console.log(`🔑 Detected Bank Transaction ID: ${transId}`);

    let receiptUrl = res.data.CopyDoc || res.data.OriginalDoc || null;
    if (!receiptUrl && res.data.DocumentsDetails && res.data.DocumentsDetails.DocumentDetails && res.data.DocumentsDetails.DocumentDetails.length > 0) {
        receiptUrl = res.data.DocumentsDetails.DocumentDetails[0].PdfLinkCopy || res.data.DocumentsDetails.DocumentDetails[0].PdfLink;
    }

    // Explicit request: Call GetTranData if we have an ID
    if (isSuccess && transId) {
        const extraReceiptUrl = await getReceiptFromKesher(transId);
        if (extraReceiptUrl) receiptUrl = extraReceiptUrl;
    }

    return {
        success: isSuccess,
        data: res.data,
        paymentMethod: 'bank',
        receiptUrl: receiptUrl,
        receiptNameUsed: receiptName, 
        receiptTZUsed: ""
    };
}

// Unified Charge Router
async function performCharge(user, amount, note, forceCC = false, creditDetails = null) {
    if (forceCC || user.preferredPaymentMethod === 'cc' || creditDetails) {
        return await chargeCreditCard(user, amount, note, creditDetails);
    } else if (user.preferredPaymentMethod === 'bank') {
         if (!user.bankDetails || user.bankDetails.status !== 'active') throw new Error("אין הרשאה בנקאית מאושרת");
         return await createBankObligation(user, amount, note);
    } else {
        throw new Error("לא נבחר אמצעי תשלום");
    }
}

// --- Cron Job ---
cron.schedule('0 8 * * *', async () => {
    const today = new Date().getDate(); 
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

        if (u.recurringDailyAmount > 0) {
            let amountToCharge = u.recurringDailyAmount;
            if (isBank && u.bankDetails.dailyLimit > 0 && amountToCharge > u.bankDetails.dailyLimit) { canCharge = false; }

            if (u.recurringImmediate === true || u.billingPreference === 0) {
                if(canCharge) {
                    try {
                        let r;
                        if(isBank) {
                            r = { success: true, paymentMethod: 'bank' }; 
                        } else {
                            r = await chargeCreditCard(u, amountToCharge, "הוראת קבע יומית");
                        }

                        if (r.success) {
                            u.totalDonated += amountToCharge;
                            u.donationsHistory.push({ 
                                amount: amountToCharge, 
                                note: "יומי קבוע", 
                                status: "success", 
                                paymentMethod: r.paymentMethod,
                                receiptUrl: r.receiptUrl,
                                receiptNameUsed: r.receiptNameUsed,
                                receiptTZUsed: r.receiptTZUsed
                            });
                        } else {
                            u.donationsHistory.push({ amount: amountToCharge, note: "יומי קבוע", status: "failed", failReason: r.data?.error || "תקלה", paymentMethod: isBank?'bank':'cc' });
                        }
                    } catch(e) { u.donationsHistory.push({ amount: amountToCharge, note: "יומי קבוע", status: "failed", failReason: e.message, paymentMethod: isBank?'bank':'cc' }); }
                    saveUser = true;
                }
            } else { u.pendingDonations.push({ amount: amountToCharge, note: "יומי קבוע (הצטברות)" }); saveUser = true; }
        }
        
        // Basket Processing
        const prefDay = parseInt(u.billingPreference);
        const currentDay = parseInt(today);
        const isChargeDay = (prefDay === currentDay);
        const isImmediateUser = (prefDay === 0);

        if ((isChargeDay || isImmediateUser) && u.pendingDonations.length > 0) {
            let totalToCharge = 0; u.pendingDonations.forEach(d => totalToCharge += d.amount);
            if (isBank && u.bankDetails.dailyLimit > 0 && totalToCharge > u.bankDetails.dailyLimit) canCharge = false; 

            if (totalToCharge > 0 && canCharge) {
                try {
                    let r;
                    if(isBank) {
                          r = { success: true, paymentMethod: 'bank' }; 
                    } else {
                          r = await chargeCreditCard(u, totalToCharge, "חיוב סל ממתין");
                    }

                    if (r.success) {
                        u.totalDonated += totalToCharge;
                        u.pendingDonations.forEach(d => { 
                            u.donationsHistory.push({ 
                                amount: d.amount, 
                                note: d.note, 
                                status: "success", 
                                date: new Date(), 
                                paymentMethod: r.paymentMethod,
                                receiptUrl: r.receiptUrl,
                                receiptNameUsed: r.receiptNameUsed,
                                receiptTZUsed: r.receiptTZUsed
                            }); 
                        });
                        u.pendingDonations = []; 
                    }
                } catch (e) { console.log(`Basket charge failed for ${u.name}: ${e.message}`); }
                saveUser = true;
            }
        }
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
        u.messages.push({ direction: 'user_to_admin', content: `בקשה להרשאה בנקאית (${
