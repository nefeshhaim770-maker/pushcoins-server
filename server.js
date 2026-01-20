<!DOCTYPE html>
<html lang="he" dir="rtl">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
    <title>קופת צדקה</title>
    <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/css/bootstrap.min.css" rel="stylesheet">
    <link href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0/css/all.min.css" rel="stylesheet">
    <script src="https://cdn.jsdelivr.net/npm/sweetalert2@11"></script>
    
    <style>
        body { background-color: #f0f2f5; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; padding-bottom: 80px; }
        .pushka-container { max-width: 500px; margin: 0 auto; background: white; min-height: 100vh; position: relative; }
        
        /* עיצוב כותרת עליונה */
        .header { 
            background: linear-gradient(135deg, #198754, #20c997); 
            color: white; 
            padding: 15px 20px; 
            border-bottom-left-radius: 25px; 
            border-bottom-right-radius: 25px; 
            display: flex; 
            justify-content: space-between; 
            align-items: center; 
            box-shadow: 0 4px 15px rgba(0,0,0,0.1); 
            position: sticky;
            top: 0;
            z-index: 1000;
        }
        
        .stat-box { text-align: center; color: white; flex-grow: 1; }
        .action-btn { background: rgba(255,255,255,0.25); border: none; color: white; width: 45px; height: 45px; border-radius: 50%; font-size: 1.2rem; position: relative; transition: 0.2s; }
        .action-btn:active { transform: scale(0.9); background: rgba(255,255,255,0.4); }
        .badge-count { position: absolute; top: -2px; right: -2px; background: #dc3545; color: white; font-size: 0.75rem; padding: 2px 6px; border-radius: 10px; border: 2px solid #198754; }
        
        /* כפתורי סכום */
        .amount-btn { width: 65px; height: 65px; border-radius: 18px; font-weight: bold; border: 2px solid #e9ecef; background: white; color: #555; margin: 6px; box-shadow: 0 2px 5px rgba(0,0,0,0.05); transition: 0.2s; }
        .amount-btn:active { transform: scale(0.95); background: #e9ecef; }
        
        /* טאבים */
        .nav-pills .nav-link { border-radius: 15px; font-weight: bold; color: #6c757d; background: #f8f9fa; margin: 0 5px; border: 1px solid #dee2e6; }
        .nav-pills .nav-link.active { background-color: #198754; color: white; border-color: #198754; box-shadow: 0 4px 6px rgba(25, 135, 84, 0.2); }
        
        /* שדות קלט */
        .custom-input { border-radius: 15px; padding: 12px; font-size: 1.1rem; border: 2px solid #e9ecef; }
        .custom-input:focus { border-color: #198754; box-shadow: none; }
    </style>
</head>
<body>

<div class="pushka-container">
    
    <div id="login-section" class="p-4 pt-5">
        <div class="text-center mb-5">
            <i class="fas fa-hand-holding-heart fa-4x text-success mb-3"></i>
            <h2 class="fw-bold">ברוכים הבאים</h2>
            <p class="text-muted">קופת צדקה דיגיטלית חכמה</p>
        </div>
        
        <div class="form-floating mb-3">
            <input type="text" id="login-input" class="form-control text-center rounded-4" placeholder="פרטים">
            <label class="w-100 text-center">מספר טלפון או אימייל</label>
        </div>
        
        <div id="otp-area" class="d-none mb-3">
            <div class="form-floating">
                <input type="number" id="otp-input" class="form-control text-center rounded-4" placeholder="קוד">
                <label class="w-100 text-center">קוד אימות (נשלח אליך)</label>
            </div>
        </div>

        <button onclick="sendCode()" id="btn-send-code" class="btn btn-success w-100 btn-lg rounded-pill shadow-sm py-3 fw-bold">שלח קוד אימות</button>
        <button onclick="verifyCode()" id="btn-verify" class="btn btn-primary w-100 btn-lg d-none rounded-pill shadow-sm py-3 fw-bold">כניסה למערכת</button>
    </div>

    <div id="app-section" class="d-none">
        
        <div class="header">
            <button class="action-btn" onclick="openSettings()"><i class="fas fa-cog"></i></button>
            <div class="stat-box">
                <small class="opacity-75" style="font-size: 0.8rem;">סך התרומות שלך</small>
                <h2 class="m-0 fw-bold" id="total-donated">₪0</h2>
            </div>
            <button class="action-btn" onclick="openBasket()">
                <i class="fas fa-shopping-cart"></i>
                <span class="badge-count d-none" id="basket-badge">0</span>
            </button>
        </div>

        <div class="p-3">
            <ul class="nav nav-pills nav-fill mb-4">
                <li class="nav-item"><a class="nav-link active" data-bs-toggle="pill" href="#tab-basket-add">הוספה לסל</a></li>
                <li class="nav-item"><a class="nav-link" data-bs-toggle="pill" href="#tab-immediate-add">תרומה מיידית</a></li>
            </ul>

            <div class="text-center">
                <label class="form-label fw-bold text-muted mb-3">בחר סכום לתרומה:</label>
                <div class="d-flex justify-content-center flex-wrap px-1">
                    <button class="amount-btn" onclick="setAmount(10)">10</button>
                    <button class="amount-btn" onclick="setAmount(18)">18</button>
                    <button class="amount-btn" onclick="setAmount(36)">36</button>
                    <button class="amount-btn" onclick="setAmount(50)">50</button>
                    <button class="amount-btn" onclick="setAmount(100)">100</button>
                </div>
                
                <input type="number" id="custom-amount" class="form-control text-center mt-4 mx-auto custom-input shadow-sm" style="width: 200px; font-size: 1.5rem;" placeholder="סכום אחר">
                <input type="text" id="donation-note" class="form-control text-center mt-3 mx-auto custom-input" style="width: 100%;" placeholder="הוסף הערה או הקדשה (אופציונלי)">

                <div class="tab-content mt-4">
                    <div class="tab-pane fade show active" id="tab-basket-add">
                        <button class="btn btn-warning w-100 btn-lg rounded-pill shadow-sm py-3 fw-bold text-dark" onclick="donate('basket')">
                            <i class="fas fa-cart-plus me-2"></i> הוסף לעגלת התרומות
                        </button>
                        <small class="text-muted d-block mt-2"><i class="fas fa-info-circle"></i> יחויב באופן מרוכז במועד שבחרת</small>
                    </div>
                    
                    <div class="tab-pane fade" id="tab-immediate-add">
                        <button class="btn btn-success w-100 btn-lg rounded-pill shadow-sm py-3 fw-bold" onclick="donate('immediate')">
                            <i class="fas fa-bolt me-2"></i> בצע חיוב מיידי
                        </button>
                        <small class="text-muted d-block mt-2"><i class="fas fa-check-circle"></i> החיוב יתבצע ברגע זה</small>
                    </div>
                </div>
            </div>
        </div>
    </div>

    <div class="modal fade" id="basketModal" tabindex="-1">
        <div class="modal-dialog modal-dialog-centered modal-dialog-scrollable">
            <div class="modal-content rounded-4 border-0">
                <div class="modal-header bg-warning-subtle border-0">
                    <h5 class="modal-title fw-bold text-dark">🛒 סל התרומות הממתין</h5>
                    <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
                </div>
                <div class="modal-body">
                    <div id="basket-list"></div>
                    <div class="alert alert-light border mt-3 mb-0 small text-center">
                        <i class="fas fa-calendar-alt text-primary"></i> הסכום יחויב ביום ה-<strong id="billing-day-display" class="text-primary">--</strong> לחודש הקרוב.
                    </div>
                </div>
            </div>
        </div>
    </div>

    <div class="modal fade" id="settingsModal" tabindex="-1">
        <div class="modal-dialog modal-dialog-centered modal-dialog-scrollable">
            <div class="modal-content rounded-4 border-0">
                <div class="modal-header border-0">
                    <h5 class="modal-title fw-bold">הגדרות ופרופיל</h5>
                    <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
                </div>
                <div class="modal-body pt-0">
                    
                    <div class="card bg-light border-0 mb-4 rounded-4">
                        <div class="card-body">
                            <h6 class="fw-bold mb-3 text-primary"><i class="fas fa-sliders-h me-1"></i> העדפות חיוב</h6>
                            
                            <label class="small text-muted mb-1 fw-bold">יום חיוב חודשי (עבור הסל)</label>
                            <select id="edit-billing-day" class="form-select mb-3 border-0 shadow-sm">
                                <option value="0">חיוב מיידי (ללא סל)</option>
                                <option value="1">1 לחודש</option>
                                <option value="2">2 לחודש</option>
                                <option value="10">10 לחודש</option>
                                <option value="15">15 לחודש</option>
                                <option value="20">20 לחודש</option>
                                <option value="25">25 לחודש</option>
                                <option value="28">28 לחודש</option>
                            </select>

                            <label class="small text-muted mb-1 fw-bold">הוראת קבע יומית (₪)</label>
                            <input type="number" id="edit-recurring" class="form-control border-0 shadow-sm" placeholder="0 (לא פעיל)">
                            <small class="text-muted" style="font-size: 0.75rem;">סכום זה יתווסף אוטומטית לסל כל יום</small>
                        </div>
                    </div>

                    <h6 class="fw-bold mt-2 ps-1">👤 פרטים אישיים</h6>
                    <div class="mb-2"><input type="text" id="edit-name" class="form-control rounded-3" placeholder="שם מלא"></div>
                    <div class="mb-2"><input type="text" id="edit-tz" class="form-control rounded-3" placeholder="תעודת זהות"></div>
                    <div class="mb-2"><input type="email" id="edit-email" class="form-control rounded-3" placeholder="אימייל"></div>
                    <div class="mb-2"><input type="tel" id="edit-phone" class="form-control rounded-3" placeholder="טלפון"></div>
                    
                    <h6 class="fw-bold mt-4 ps-1">💳 אמצעי תשלום</h6>
                    <div class="d-flex justify-content-between align-items-center border rounded-3 p-3 mb-3 bg-white shadow-sm">
                        <div class="d-flex align-items-center">
                            <i class="far fa-credit-card fa-lg me-3 text-secondary"></i>
                            <span id="credit-info" class="fw-bold text-dark">טוען...</span>
                        </div>
                        <button class="btn btn-sm btn-outline-danger rounded-pill px-3" onclick="resetCreditCard()">החלף</button>
                    </div>

                    <h6 class="fw-bold mt-3 ps-1">🔒 אבטחה</h6>
                    <div class="mb-3">
                        <label class="small text-muted mb-1">קוד PIN לאבטחת תרומה (4 ספרות)</label>
                        <input type="password" id="edit-pin" class="form-control text-center rounded-3 letter-spacing-2" maxlength="4" placeholder="••••">
                    </div>

                    <button class="btn btn-primary w-100 py-3 rounded-pill fw-bold shadow-sm mt-2" onclick="saveSettings()">שמור שינויים</button>
                </div>
            </div>
        </div>
    </div>

</div>

<script src="https://www.gstatic.com/firebasejs/8.10.1/firebase-app.js"></script>
<script src="https://www.gstatic.com/firebasejs/8.10.1/firebase-messaging.js"></script>

<script>
    // ==========================================
    // הגדרות מערכת ו-Firebase
    // ==========================================
    
    // כתובת השרת שלך
    const API_URL = "https://pushcoins-server.onrender.com"; 

    // הגדרות Firebase - הועתק מהתמונות ששלחת
    const firebaseConfig = {
        apiKey: "AIzaSyDuFnImbXAjc5fINUVNAMKf073kke4MSyo",
        authDomain: "pushkaapp-45e4f.firebaseapp.com",
        projectId: "pushkaapp-45e4f",
        storageBucket: "pushkaapp-45e4f.firebasestorage.app",
        messagingSenderId: "810482014009",
        appId: "1:810482014009:web:0b4601cb35b6d88c91fae8"
    };

    // מפתח VAPID מהתמונה ששלחת
    const VAPID_KEY = "BDj7ELURxTEpypCdzF4aLo-RypB3iYSS181PoS5RsCpWF3HG7vsGgG36OGYWZvgQbXWHY43OtIv6VU9TEcTBjMO";

    // אתחול Firebase
    firebase.initializeApp(firebaseConfig);
    const messaging = firebase.messaging();

    let currentUserId = localStorage.getItem('userId');
    let currentUser = null;

    // בטעינת הדף
    window.onload = () => { 
        if (currentUserId) {
            loadUserProfile();
            setTimeout(registerForPush, 3000); // מנסה להירשם לפוש ברקע אחרי 3 שניות
        }
    };

    function setAmount(val) { document.getElementById('custom-amount').value = val; }

    // --- לוגיקה של פוש (Notification) ---
    async function registerForPush() {
        if (!currentUserId) return;
        try {
            console.log("בודק הרשאות פוש...");
            const permission = await Notification.requestPermission();
            if (permission === 'granted') {
                const token = await messaging.getToken({ vapidKey: VAPID_KEY });
                if (token) {
                    await fetch(`${API_URL}/save-push-token`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ userId: currentUserId, token: token })
                    });
                    console.log('✅ Push Token Saved successfully');
                }
            } else {
                console.log('Push permission denied');
            }
        } catch (err) { console.error('Push Error:', err); }
    }

    // האזנה להודעות כשהאתר פתוח
    messaging.onMessage((payload) => {
        Swal.fire({
            title: payload.notification.title,
            text: payload.notification.body,
            icon: 'info',
            toast: true,
            position: 'top-end',
            showConfirmButton: false,
            timer: 5000,
            background: '#fff',
            iconColor: '#198754'
        });
    });

    // --- התחברות (Auth) ---
    async function sendCode() {
        const input = document.getElementById('login-input').value;
        if (!input) return Swal.fire('שגיאה', 'נא להזין מספר טלפון או מייל', 'warning');
        
        const isEmail = input.includes('@');
        const payload = isEmail ? { email: input } : { phone: input };
        const code = Math.floor(1000 + Math.random() * 9000); 

        Swal.fire({title:'מתחבר לשרת...', didOpen:()=>Swal.showLoading()});

        try {
            await fetch(`${API_URL}/update-code`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ ...payload, code: code.toString() })
            });
            Swal.fire('קוד נשלח!', 'בדוק את המייל או בלוגים (Logs)', 'success');
            document.getElementById('btn-send-code').classList.add('d-none');
            document.getElementById('otp-area').classList.remove('d-none');
            document.getElementById('btn-verify').classList.remove('d-none');
        } catch(e) { 
            Swal.close();
            Swal.fire('תקלה', 'לא ניתן להתחבר לשרת', 'error'); 
        }
    }

    async function verifyCode() {
        const input = document.getElementById('login-input').value;
        const code = document.getElementById('otp-input').value;
        
        if (!code) return Swal.fire('שגיאה', 'נא להזין קוד', 'warning');

        const isEmail = input.includes('@');
        
        // מציג חלונית טעינה שלא נסגרת לבד
        Swal.fire({
            title: 'מאמת נתונים...',
            allowOutsideClick: false,
            didOpen: () => Swal.showLoading()
        });

        try {
            const res = await fetch(`${API_URL}/verify-auth`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ 
                    email: isEmail ? input : undefined, 
                    phone: !isEmail ? input : undefined, 
                    code: code 
                })
            });

            const data = await res.json();
            Swal.close(); // סגירה כפויה של הטעינה

            if (data.success) {
                currentUserId = data.user._id;
                localStorage.setItem('userId', currentUserId);
                
                await loadUserProfile(); // טעינת המשתמש
                registerForPush(); // בקשת פוש ברקע
            } else {
                Swal.fire('שגיאה', 'קוד שגוי', 'error');
            }
        } catch (e) {
            Swal.close();
            Swal.fire('תקלה', 'שגיאת תקשורת עם השרת.\n' + e.message, 'error');
        }
    }

    // --- טעינת נתונים ---
    async function loadUserProfile() {
        try {
            const res = await fetch(`${API_URL}/login-by-id`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ userId: currentUserId })
            });
            const data = await res.json();
            if(data.success) {
                currentUser = data.user;
                document.getElementById('login-section').classList.add('d-none');
                document.getElementById('app-section').classList.remove('d-none');
                
                // עדכון כותרת
                document.getElementById('total-donated').innerText = `₪${(currentUser.totalDonated||0).toFixed(0)}`;
                const pendingCount = currentUser.pendingDonations?.length || 0;
                const badge = document.getElementById('basket-badge');
                badge.innerText = pendingCount;
                badge.classList.toggle('d-none', pendingCount === 0);

                // מילוי טופס הגדרות
                document.getElementById('edit-name').value = currentUser.name || "";
                document.getElementById('edit-tz').value = currentUser.tz || "";
                document.getElementById('edit-email').value = currentUser.email || "";
                document.getElementById('edit-phone').value = currentUser.phone || "";
                document.getElementById('edit-billing-day').value = currentUser.billingPreference || 0;
                document.getElementById('edit-recurring').value = currentUser.recurringDailyAmount || "";
                document.getElementById('edit-pin').value = currentUser.securityPin || "";
                document.getElementById('billing-day-display').innerText = currentUser.billingPreference || "מיידי";
                
                // תצוגת אשראי
                const creditInfo = document.getElementById('credit-info');
                if(currentUser.lastCardDigits) {
                    creditInfo.innerHTML = `<span class='text-success'>כרטיס מסתיים ב-<strong>${currentUser.lastCardDigits}</strong></span>`;
                } else {
                    creditInfo.innerHTML = "<span class='text-danger'>לא שמור כרטיס</span>";
                }

                renderBasket();
            }
        } catch (e) {
            console.error(e);
        }
    }

    // --- פעולות תרומה ---
    async function donate(mode) {
        const amount = document.getElementById('custom-amount').value;
        const note = document.getElementById('donation-note').value;
        if(!amount || amount <= 0) return Swal.fire('שגיאה', 'אנא הכנס סכום לתרומה', 'warning');

        // בדיקת PIN
        if(currentUser.securityPin) {
            const {value:pin} = await Swal.fire({
                title: '🔒 אימות אבטחה', 
                text: 'הכנס את קוד ה-PIN שלך',
                input: 'password', 
                inputAttributes:{maxlength:4, inputmode:'numeric'},
                confirmButtonText: 'אשר',
                cancelButtonText: 'ביטול',
                showCancelButton: true
            });
            if(!pin) return;
            if(pin !== currentUser.securityPin) return Swal.fire('שגיאה', 'קוד PIN שגוי', 'error');
        }

        const isImmediate = (mode === 'immediate');
        if(!currentUser.token && isImmediate) return Swal.fire('חסר אשראי', 'אין כרטיס שמור לחיוב מיידי.\nאנא בחר "הוסף לסל" או פנה למנהל.', 'warning');

        Swal.fire({title: isImmediate ? 'מבצע חיוב...' : 'מוסיף לסל...', didOpen:()=>Swal.showLoading()});
        
        try {
            const res = await fetch(`${API_URL}/donate`, {
                method: 'POST', headers: {'Content-Type':'application/json'},
                body: JSON.stringify({ userId: currentUserId, amount, useToken: true, note, forceImmediate: isImmediate })
            });
            const data = await res.json();
            
            Swal.close();

            if(data.success) {
                Swal.fire({
                    title: 'הצלחה!', 
                    text: data.message, 
                    icon: 'success',
                    timer: 2000,
                    showConfirmButton: false
                });
                loadUserProfile();
                document.getElementById('custom-amount').value = '';
                document.getElementById('donation-note').value = '';
            } else Swal.fire('שגיאה', data.error, 'error');
        } catch(e) {
            Swal.close();
            Swal.fire('תקלה', 'שגיאה בביצוע הפעולה', 'error');
        }
    }

    // --- ניהול סל ---
    function openBasket() { new bootstrap.Modal(document.getElementById('basketModal')).show(); }
    
    function renderBasket() {
        const list = document.getElementById('basket-list');
        list.innerHTML = '';
        if(!currentUser.pendingDonations?.length) {
            list.innerHTML = '<div class="text-center py-4 text-muted"><i class="fas fa-shopping-basket fa-3x mb-3 opacity-25"></i><br>העגלה ריקה</div>';
            return;
        }
        currentUser.pendingDonations.forEach(item => {
            list.innerHTML += `
                <div class="d-flex justify-content-between align-items-center border-bottom py-3">
                    <div class="d-flex align-items-center">
                        <div class="bg-success-subtle text-success rounded-circle p-2 me-3" style="width:40px;height:40px;display:flex;align-items:center;justify-content:center;">
                            <i class="fas fa-coins"></i>
                        </div>
                        <div>
                            <span class="fw-bold fs-5">₪${item.amount}</span>
                            <div class="text-muted small">${item.note || 'ללא הערה'}</div>
                        </div>
                    </div>
                    <button class="btn btn-outline-danger btn-sm rounded-circle" style="width:35px;height:35px;" onclick="deletePending('${item._id}')"><i class="fas fa-trash-alt"></i></button>
                </div>
            `;
        });
    }
    
    async function deletePending(id) {
        await fetch(`${API_URL}/delete-pending`, {
            method: 'POST', headers: {'Content-Type':'application/json'},
            body: JSON.stringify({ userId: currentUserId, donationId: id })
        });
        loadUserProfile();
    }

    // --- הגדרות ---
    function openSettings() { new bootstrap.Modal(document.getElementById('settingsModal')).show(); }

    async function saveSettings() {
        const data = {
            userId: currentUserId,
            name: document.getElementById('edit-name').value,
            tz: document.getElementById('edit-tz').value,
            email: document.getElementById('edit-email').value,
            phone: document.getElementById('edit-phone').value,
            billingPreference: document.getElementById('edit-billing-day').value,
            recurringDailyAmount: document.getElementById('edit-recurring').value,
            securityPin: document.getElementById('edit-pin').value
        };

        Swal.fire({title:'שומר...', didOpen:()=>Swal.showLoading()});
        await fetch(`${API_URL}/update-profile`, {
            method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(data)
        });
        bootstrap.Modal.getInstance(document.getElementById('settingsModal')).hide();
        Swal.fire({title:'נשמר', icon:'success', timer:1500, showConfirmButton:false});
        loadUserProfile();
    }

    async function resetCreditCard() {
        const result = await Swal.fire({
            title: 'למחוק את הכרטיס?',
            text: "פעולה זו תמחק את האשראי השמור במערכת",
            icon: 'warning',
            showCancelButton: true,
            confirmButtonColor: '#d33',
            confirmButtonText: 'כן, מחק',
            cancelButtonText: 'ביטול'
        });

        if (result.isConfirmed) {
            await fetch(`${API_URL}/reset-token`, {
                method: 'POST', headers: {'Content-Type':'application/json'},
                body: JSON.stringify({ userId: currentUserId })
            });
            loadUserProfile();
            Swal.fire('נמחק!', 'פרטי האשראי הוסרו.', 'success');
        }
    }
</script>

<script src="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/js/bootstrap.bundle.min.js"></script>
</body>
</html>
