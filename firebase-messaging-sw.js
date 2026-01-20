<script src="https://www.gstatic.com/firebasejs/8.10.1/firebase-app.js"></script>
<script src="https://www.gstatic.com/firebasejs/8.10.1/firebase-messaging.js"></script>

<script>
    // הגדרות Firebase
    const firebaseConfig = {
        apiKey: "AIzaSyDuFnImbXAjc5fINUVNAMKf073kke4MSyo",
        authDomain: "pushkaapp-45e4f.firebaseapp.com",
        projectId: "pushkaapp-45e4f",
        storageBucket: "pushkaapp-45e4f.firebasestorage.app",
        messagingSenderId: "810482014009",
        appId: "1:810482014009:web:0b4601cb35b6d88c91fae8"
    };

    // המפתח הארוך מהתמונה השנייה
    const VAPID_KEY = "BDj7ELURxTEpypCdzF4aLo-RypB3iYSS181PoS5RsCpWF3HG7vsGgG36OGYWZvgQbXWHY43OtIv6VU9TEcTBjMO";

    // אתחול
    firebase.initializeApp(firebaseConfig);
    const messaging = firebase.messaging();

    // פונקציה לרישום לפוש - מופעלת אוטומטית כשהמשתמש מחובר
    async function registerForPush() {
        if (!currentUserId) return;

        try {
            console.log('מבקש אישור התראות...');
            const permission = await Notification.requestPermission();
            
            if (permission === 'granted') {
                console.log('התקבל אישור, מנפיק טוקן...');
                const token = await messaging.getToken({ vapidKey: VAPID_KEY });
                
                if (token) {
                    console.log('טוקן התקבל:', token);
                    // שליחת הטוקן לשרת לשמירה
                    await fetch(`${API_URL}/save-push-token`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ userId: currentUserId, token: token })
                    });
                    console.log('טוקן נשמר בשרת!');
                } else {
                    console.log('לא התקבל טוקן.');
                }
            } else {
                console.log('המשתמש סירב לקבל התראות.');
            }
        } catch (err) {
            console.error('שגיאה ברישום לפוש:', err);
        }
    }

    // נסה להירשם כשהדף עולה (אם המשתמש מחובר)
    if (localStorage.getItem('userId')) {
        registerForPush();
    }

    // קבלת הודעות כשהאתר פתוח
    messaging.onMessage((payload) => {
        console.log('הודעה התקבלה:', payload);
        Swal.fire({
            title: payload.notification.title,
            text: payload.notification.body,
            icon: 'info',
            toast: true,
            position: 'top-end',
            showConfirmButton: false,
            timer: 5000
        });
    });
</script>
