<!DOCTYPE html>
<html lang="he" dir="rtl">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>PushCoins</title>
    <link href="https://fonts.googleapis.com/css2?family=Rubik:wght@400;500;700&display=swap" rel="stylesheet">
    <style>
        :root { --primary: #007aff; --success: #34c759; --bg: #f2f2f7; --card: #ffffff; }
        body { font-family: 'Rubik', sans-serif; background: var(--bg); margin: 0; padding: 20px; display: flex; justify-content: center; }
        .app-container { width: 100%; max-width: 400px; background: var(--card); border-radius: 24px; padding: 25px; box-shadow: 0 8px 30px rgba(0,0,0,0.05); }
        input { width: 100%; padding: 15px; margin: 10px 0; border: 2px solid #eee; border-radius: 14px; box-sizing: border-box; font-size: 16px; }
        .main-btn { width: 100%; padding: 16px; background: var(--primary); color: white; border: none; border-radius: 14px; font-size: 18px; font-weight: 600; cursor: pointer; }
        .hidden { display: none; }
        .saved-card { background: #eef7ff; padding: 15px; border-radius: 14px; margin: 10px 0; border: 1px solid var(--primary); font-size: 14px; }
    </style>
</head>
<body>
    <div class="app-container">
        <div id="login-screen">
            <h1>🪙 PushCoins</h1>
            <p>הכנס אימייל לקבלת קוד:</p>
            <input type="email" id="email-input" placeholder="yourname@gmail.com">
            <button class="main-btn" onclick="sendAuth()">שלח קוד</button>
        </div>

        <div id="verify-screen" class="hidden">
            <h1>🔐 אימות</h1>
            <p>הזן את הקוד שקיבלת במייל:</p>
            <input type="tel" id="otp-input" placeholder="4 ספרות" maxlength="4">
            <button class="main-btn" onclick="verifyAuth()">התחבר</button>
        </div>

        <div id="main-screen" class="hidden">
            <div style="text-align:right; margin-bottom:15px;">
                <b>שלום, <span id="user-name"></span></b><br>
                נתרמו: ₪<span id="user-total">0</span>
            </div>
            <input type="number" id="amount" placeholder="סכום לתרומה ב-₪">
            
            <div id="payment-fields">
                <input type="tel" id="cc-num" placeholder="מספר כרטיס">
                <div style="display:flex; gap:10px;">
                    <input type="tel" id="cc-exp" placeholder="MMYY">
                    <input type="tel" id="cc-cvv" placeholder="CVV">
                </div>
            </div>

            <div id="card-saved" class="hidden saved-card">
                💳 כרטיס שמור: **** <span id="card-digits"></span>
                <br><a href="#" onclick="changeCard()" style="color:var(--primary); text-decoration:none; font-size:12px;">החלף כרטיס</a>
            </div>

            <input type="text" id="full-name" placeholder="שם מלא">
            <input type="tel" id="tz" placeholder="תעודת זהות">
            <button class="main-btn" id="donate-btn" onclick="donate()" style="background:var(--success); margin-top:10px;">תרום ❤️</button>
        </div>
    </div>

    <script>
        const API = 'https://pushcoins-server.onrender.com';
        let user = null;

        async function sendAuth() {
            const email = document.getElementById('email-input').value;
            await fetch(`${API}/send-auth`, { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({ email }) });
            document.getElementById('login-screen').classList.add('hidden');
            document.getElementById('verify-screen').classList.remove('hidden');
        }

        async function verifyAuth() {
            const email = document.getElementById('email-input').value;
            const code = document.getElementById('otp-input').value;
            const res = await fetch(`${API}/verify-auth`, { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({ email, code }) });
            const data = await res.json();
            if(data.success) { user = data.user; showMain(); } else { alert('קוד שגוי'); }
        }

        function showMain() {
            document.getElementById('verify-screen').classList.add('hidden');
            document.getElementById('main-screen').classList.remove('hidden');
            document.getElementById('user-name').innerText = user.name || user.email;
            document.getElementById('user-total').innerText = user.totalDonated;
            if(user.token) {
                document.getElementById('payment-fields').classList.add('hidden');
                document.getElementById('card-saved').classList.remove('hidden');
                document.getElementById('card-digits').innerText = user.lastCardDigits;
            }
        }

        function changeCard() {
            document.getElementById('payment-fields').classList.remove('hidden');
            document.getElementById('card-saved').classList.add('hidden');
        }

        async function donate() {
            const btn = document.getElementById('donate-btn');
            btn.innerText = 'מעבד...';
            const isToken = document.getElementById('payment-fields').classList.contains('hidden');
            const res = await fetch(`${API}/donate`, {
                method: 'POST', headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({
                    email: user.email,
                    amount: document.getElementById('amount').value,
                    fullName: document.getElementById('full-name').value,
                    tz: document.getElementById('tz').value,
                    useToken: isToken,
                    ccDetails: isToken ? null : {
                        num: document.getElementById('cc-num').value,
                        exp: document.getElementById('cc-exp').value,
                        cvv: document.getElementById('cc-cvv').value
                    }
                })
            });
            const data = await res.json();
            if(data.success) { alert('תודה!'); user = data.user; showMain(); } else { alert('שגיאה'); }
            btn.innerText = 'תרום ❤️';
        }
    </script>
</body>
</html>
