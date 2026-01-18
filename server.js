// ... (חלקי הקוד הקודמים של החיבור ל-DB נשארים אותו דבר)

app.post('/donate', async (req, res) => {
    const { userId, amount, ccDetails, fullName, tz, useToken, phone, email, note } = req.body;
    try {
        let user = await User.findById(userId);
        if (!user) return res.status(404).json({ error: "User not found" });

        let tranData = {
            Total: Math.round(parseFloat(amount) * 100),
            Currency: 1, 
            CreditType: 1, 
            Phone: phone || user.phone || "0500000000",
            FirstName: (fullName || user.name || "T").split(" ")[0],
            LastName: (fullName || user.name || "T").split(" ").slice(1).join(" ") || "T",
            Mail: email || user.email || "no-email@test.com", 
            Id: tz || user.tz || "", 
            ParamJ: "J4", 
            TransactionType: "debit"
        };

        // לוגיקת טוקן מתוקנת
        if (useToken && user.token && user.token !== "") {
            // שולחים את הטוקן הקיים
            tranData.Token = user.token;
        } else if (ccDetails && ccDetails.num) {
            // שליחת כרטיס חדש כדי ליצור טוקן חדש
            let exp = ccDetails.exp;
            if (exp.length === 4) exp = exp.substring(2,4) + exp.substring(0,2);
            tranData.CreditNum = ccDetails.num; 
            tranData.Expiry = exp; 
            tranData.Cvv2 = ccDetails.cvv;
        } else {
            return res.status(400).json({ success: false, error: "חסרים פרטי תשלום או טוקן" });
        }

        const response = await axios.post('https://kesherhk.info/ConnectToKesher/ConnectToKesher', {
            Json: { 
                userName: '2181420WS2087', 
                password: 'WVmO1iterNb33AbWLzMjJEyVnEQbskSZqyel5T61Hb5qdwR0gl', 
                func: "SendTransaction", 
                format: "json", 
                tran: tranData 
            },
            format: "json"
        });

        const resData = response.data;
        
        // בדיקת הצלחה מול שרת קשר
        if (resData.RequestResult?.Status === true || resData.Status === true) {
            user.totalDonated += parseFloat(amount);
            if (fullName) user.name = fullName;
            if (tz) user.tz = tz;
            if (phone) user.phone = phone;
            if (email) user.email = email;
            if (note) user.notes.push(note);
            
            // חילוץ הטוקן החדש מהתגובה (חשוב מאוד!)
            const rToken = resData.Token || resData.RequestResult?.Token;
            if (rToken) {
                user.token = rToken; // מעדכן את הטוקן בבסיס הנתונים
                if (!useToken && ccDetails) {
                    user.lastCardDigits = ccDetails.num.slice(-4);
                }
            }
            
            await user.save();
            res.json({ success: true, user });
        } else { 
            // אם הטוקן נדחה, נחזיר תשובה שמאפשרת למשתמש להבין שצריך להזין כרטיס מחדש
            let errorDesc = resData.RequestResult?.Description || resData.Description || "העסקה נדחתה";
            res.status(400).json({ success: false, error: errorDesc }); 
        }
    } catch (e) { 
        res.status(500).json({ success: false, error: "שגיאת תקשורת" }); 
    }
});
