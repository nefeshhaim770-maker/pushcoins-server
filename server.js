// ... (חלקי הקוד הקודמים נשארים דומים)
app.post('/donate', async (req, res) => {
    const { phone, amount, ccDetails, email, fullName, tz } = req.body;
    
    try {
        const totalAgorot = parseInt(amount) * 100;
        
        // תיקון אוטומטי של התוקף לפורמט YYMM הנדרש
        let finalExpiry = ccDetails.exp; // המשתמש מזין למשל 0426
        if (finalExpiry.length === 4) {
            // הפיכה מ-MMYY ל-YYMM
            finalExpiry = finalExpiry.substring(2,4) + finalExpiry.substring(0,2);
        }

        const payload = {
            Json: {
                userName: KESHER_USER,
                password: KESHER_PASS,
                func: "SendTransaction",
                format: "json",
                tran: {
                    CreditNum: ccDetails.num,
                    Expiry: finalExpiry, // הפורמט המתוקן
                    Total: totalAgorot,
                    Cvv2: ccDetails.cvv,
                    Currency: 1,
                    CreditType: 1,
                    Phone: phone,
                    FirstName: (fullName || "Torem").split(" ")[0],
                    LastName: (fullName || "Torem").split(" ").slice(1).join(" ") || ".",
                    Mail: email || "app@donate.com",
                    TZ: tz || ""
                }
            },
            format: "json"
        };

        const response = await axios.post(KESHER_URL, payload);
        console.log("KESHER RESPONSE:", JSON.stringify(response.data));

        if (response.data.RequestResult?.Status === true) {
            let user = await User.findOne({ phone });
            if(user) {
                user.totalDonated += parseInt(amount);
                user.name = fullName;
                user.email = email;
                user.tz = tz;
                // שמירת 4 ספרות אחרונות לתצוגה
                user.lastCardDigits = ccDetails.num.slice(-4);
                // כאן נשמור את הטוקן כשהוא יחזור מהם בפורמט הנכון
                await user.save();
            }
            res.json({ success: true, newTotal: user.totalDonated });
        } else {
            res.status(400).json({ success: false, error: response.data.RequestResult?.Description || "נדחה" });
        }
    } catch (e) {
        res.status(500).json({ success: false, error: "שגיאת שרת" });
    }
});
