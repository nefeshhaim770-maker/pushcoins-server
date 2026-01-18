async function sendAuth() {
            const email = document.getElementById('email-login').value;
            if(!email.includes('@')) return alert('נא להזין מייל תקין');
            
            const btn = document.getElementById('send-btn');
            btn.innerHTML = 'השרת מתעורר (זה עשוי לקחת דקה)... <span class="loader"></span>';
            btn.disabled = true; // מניעת לחיצות כפולות

            try {
                // הוספת טיימאאוט ארוך יותר לפני שהאפליקציה מתייאשת
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), 60000); // מחכה עד 60 שניות

                const res = await fetch(`${API}/send-auth`, {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({ email }),
                    signal: controller.signal
                });
                
                clearTimeout(timeoutId);

                if(res.ok) {
                    document.getElementById('login-screen').classList.add('hidden');
                    document.getElementById('verify-screen').classList.remove('hidden');
                } else { 
                    const errorData = await res.json();
                    alert('שגיאה מהשרת: ' + (errorData.error || 'נסה שוב בעוד רגע')); 
                }
            } catch(e) { 
                alert('השרת עדיין בתהליך התעוררות. אנא המתן 30 שניות ונסה ללחוץ שוב.'); 
            } finally {
                btn.innerText = 'שלח קוד אימות';
                btn.disabled = false;
            }
        }
