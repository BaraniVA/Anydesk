use remotelink::server::start_signaling_server;
use tokio_util::sync::CancellationToken;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    println!("==================================================");
    println!("RemoteLink Central Signaling Server");
    println!("Starting server on port 3000...");
    println!("==================================================");
    
    let token = CancellationToken::new();
    let addr = start_signaling_server(token.clone()).await?;
    println!("Signaling server running on: {}", addr);
    println!("Press Ctrl+C to stop.");
    
    tokio::signal::ctrl_c().await?;
    println!("Shutdown signal received, exiting server.");
    Ok(())
}
