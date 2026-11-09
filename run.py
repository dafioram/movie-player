from http.server import HTTPServer, SimpleHTTPRequestHandler

class CustomHandler(SimpleHTTPRequestHandler):
    def do_GET(self):
        if self.path == '/':
            self.path = '/index.html'
        return super().do_GET()

def run_server():
    server_address = ("", 8000) # Listens on all available interfaces
    httpd = HTTPServer(server_address, CustomHandler)
    print("Server running on port 8000...")
    
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down server safely.")
        httpd.server_close()

if __name__ == "__main__":
    run_server()