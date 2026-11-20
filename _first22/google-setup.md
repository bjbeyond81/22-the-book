# Google campaign deployment

Use a dedicated BJ Beyond Google account or an account explicitly approved as the public email sender. MailApp sends as the account deploying the script. Set up this project privately and leave the public website unchanged until the test succeeds.

- Add GoogleSignup.gs to the Apps Script project and use google-appsscript.json as appsscript.json. The advanced Sheets service uses the drive.file scope for files created by the app. MailApp requires send-mail authorization.
- Run setupTestingSheet_ to create the private test registry. In Script properties set F22_MODE to test and F22_TEST_EMAIL to the exact mailbox approved for the test. Deploy as a web app executing as the owner, with anonymous access for participants. A test submission sends email only to the specified test mailbox.
- Substitute the deployed /exec URL in index.template.html. With the URL in a private preview, submit the form, verify email receipt, click the confirmation button, and check the first slot in the test registry. Test both website languages.
- Run setupPrivateSheet_ to create a separate empty private production registry. Add a daily time-driven trigger for cleanupDaily_. Set F22_MODE to live when the test has passed and the sender is approved. Commit the finished index.html to the publishing branch.
- On release, send the eBook individually to the confirmed addresses in slots 1 through 22, in their selected language. Record the successful delivery timestamp as UTC milliseconds in the last column. The scheduled cleanup clears the email and confirmation data after 30 days.
